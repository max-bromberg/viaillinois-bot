import { campusStamp } from '../render/campusTime.ts';
import { ANNOUNCEMENTS_CONSUMER, type OutboxCursors } from './cursor.ts';
import type { OutboxEntry, ViaClient } from '../via/client.ts';

/**
 * The outbox consumer.
 *
 * One loop, polling the outbox endpoint every few seconds from the cursor it
 * holds, handing each entry to the handler registered for its kind, in order.
 * The cursor advances only after an entry has been handled, which is the
 * whole design: the web platform delivers each entry at least once, every
 * post an entry causes is written to Deliveries before it is made, and the
 * two together give exactly once posting into Discord under any single
 * failure.
 *
 * Three failures are handled here, and each of them is a way a bot actually
 * falls over.
 *
 * An entry of a kind nothing handles is not an error. The web platform writes
 * every kind in section 8 of the design and the bot grows its handlers one
 * increment at a time, so an unhandled kind advances the cursor with a line in
 * the log rather than stopping the queue behind it.
 *
 * An entry whose handler throws stops the batch where it is, without
 * advancing, so the next poll reads the same entry again. That is what makes
 * a crash in the middle of an entry safe.
 *
 * An entry that keeps throwing is left behind after a bound on attempts, with
 * a log line loud enough to be found, because one entry naming a channel that
 * no longer exists must not stop every announcement in every server forever.
 * The attempts are counted in memory, so a restart starts the bound again,
 * which is right: the commonest reason for an entry to fail is that something
 * outside the bot was briefly wrong.
 */

/** What handling one entry means. Throwing asks for the entry to be tried again. */
export type OutboxHandler = (entry: OutboxEntry) => Promise<void>;

/** The handlers, by the outbox kind each one answers. */
export type OutboxHandlers = Record<string, OutboxHandler>;

/** How many entries one poll asks for. */
export const DEFAULT_BATCH_SIZE = 50;

/** How long the loop waits between polls, which the design puts at a few seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** How many times one entry is tried before it is left behind. */
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface OutboxConsumerOptions {
  via: Pick<ViaClient, 'readOutbox'>;
  cursors: OutboxCursors;
  handlers: OutboxHandlers;
  /** The name the cursor row is keyed by, which the first release keeps at one. */
  consumer?: string;
  /**
   * Drop what the client holds for an organization an entry touched, so a
   * change made on the website shows in Discord within seconds rather than
   * within the cache's minute.
   */
  invalidateRso?: (rsoId: number) => void;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

/** What one poll did, which is what the tests and the log read. */
export interface PollResult {
  /** How many entries a handler handled. */
  handled: number;
  /** How many entries had no handler and were moved past. */
  unhandled: number;
  /** How many entries were left behind after the bound on attempts. */
  skipped: number;
}

/** What the health endpoint reports about the consumer. */
export interface ConsumerState {
  /** The last entry finished, or null before the first poll. */
  cursor: number | null;
  /** When the consumer last read the outbox, in campus wall clock. */
  lastPollAt: string | null;
}

export interface OutboxConsumer {
  /** One poll, for a test and for the loop. */
  runOnce(): Promise<PollResult>;
  /**
   * Start the loop, which polls until it is stopped. The promise it answers
   * with is the loop itself, so a caller that wants to wait for the loop to
   * end can, and the bot's entry point, which does not, need not.
   */
  start(): Promise<void>;
  /** Stop the loop and wait for the poll in flight to finish. */
  stop(): Promise<void>;
  state(): ConsumerState;
}

export function createOutboxConsumer(options: OutboxConsumerOptions): OutboxConsumer {
  const {
    via,
    cursors,
    handlers,
    consumer = ANNOUNCEMENTS_CONSUMER,
    invalidateRso,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = options;

  /** How many times each entry has failed, kept only for as long as the process runs. */
  const attempts = new Map<number, number>();
  let running = false;
  let loop: Promise<void> | null = null;
  let cursor: number | null = null;
  let lastPollAt: string | null = null;

  async function handle(entry: OutboxEntry): Promise<'handled' | 'unhandled' | 'failed' | 'skipped'> {
    const handler = handlers[entry.kind];
    if (!handler) {
      console.log(`outbox entry ${entry.outboxId} of kind ${entry.kind} has no handler, moving past it`);
      return 'unhandled';
    }

    try {
      await handler(entry);
      attempts.delete(entry.outboxId);
      return 'handled';
    } catch (err) {
      const failures = (attempts.get(entry.outboxId) ?? 0) + 1;
      attempts.set(entry.outboxId, failures);

      if (failures >= maxAttempts) {
        console.error(
          `outbox entry ${entry.outboxId} of kind ${entry.kind} failed ${failures} times and is being left behind: ${(err as Error).message}`,
        );
        attempts.delete(entry.outboxId);
        return 'skipped';
      }

      console.error(
        `handling outbox entry ${entry.outboxId} of kind ${entry.kind} failed on attempt ${failures}: ${(err as Error).message}`,
      );
      return 'failed';
    }
  }

  async function runOnce(): Promise<PollResult> {
    const result: PollResult = { handled: 0, unhandled: 0, skipped: 0 };
    lastPollAt = campusStamp(now());

    let after: number;
    let page;
    try {
      after = await cursors.read(consumer);
      cursor = after;
      page = await via.readOutbox({ after, limit: batchSize });
    } catch (err) {
      // The web platform comes back. A poll that could not read is a poll
      // that did nothing, and the next one reads the same entries.
      console.error('reading the outbox failed:', (err as Error).message);
      return result;
    }

    for (const entry of page.entries) {
      const outcome = await handle(entry);
      if (outcome === 'failed') return result;

      if (outcome === 'handled') result.handled += 1;
      if (outcome === 'unhandled') result.unhandled += 1;
      if (outcome === 'skipped') result.skipped += 1;

      // The cursor advances only once everything the entry asked for has
      // been recorded, which is what the handler returning means.
      await cursors.advance(consumer, entry.outboxId);
      cursor = entry.outboxId;

      if (outcome === 'handled' && entry.rsoId !== null) invalidateRso?.(entry.rsoId);
    }

    return result;
  }

  async function poll(): Promise<void> {
    while (running) {
      try {
        await runOnce();
      } catch (err) {
        // Nothing in runOnce is expected to throw, and a loop that ends
        // because something did would leave the bot silently deaf.
        console.error('an outbox poll failed:', (err as Error).message);
      }
      if (!running) break;
      await sleep(pollIntervalMs);
    }
  }

  return {
    runOnce,

    start(): Promise<void> {
      if (running) return loop ?? Promise.resolve();
      running = true;
      loop = poll();
      return loop;
    },

    async stop(): Promise<void> {
      running = false;
      await loop;
      loop = null;
    },

    state(): ConsumerState {
      return { cursor, lastPollAt };
    },
  };
}
