import { ANNOUNCEMENTS_CONSUMER, type OutboxCursors } from '../outbox/cursor.ts';
import { campusDatePlus, campusStamp, toInstant } from '../render/campusTime.ts';
import { NO_OUTBOX_ENTRY, type Deliveries } from '../delivery/deliveries.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { JobHour } from './scheduler.ts';
import type { RateWindows } from '../ratelimit/windows.ts';
import type { ScheduledEventMirror } from '../mirror/scheduledEvents.ts';

/**
 * The housekeeping that keeps the bot healthy.
 *
 * Two things happen here once a day, and they are one job because they are the
 * same kind of work: neither is owed to anybody, both are about the bot's own
 * state, and both are safe to run again.
 *
 * The first is retention. Section 10 of the design keeps Deliveries and
 * Rate_Windows for ninety days and nothing longer. The rate windows are also
 * swept down to a couple of hours as they are used, which is what keeps that
 * table small from minute to minute; the ninety day bound is the promise made
 * to the people the rows are about, and it is kept here whether the sweep ran
 * or not.
 *
 * The second is the outbox. The web platform prunes the outbox after thirty
 * days, so a cursor that has not moved in longer than that names an entry that
 * has been deleted, and everything between it and the head of the outbox has
 * gone with it. Reading on from that cursor would silently miss all of it. So
 * the bot stops trusting the cursor, says so loudly in the log, and rebuilds
 * what it mirrors in each server from the reading endpoints, which are the
 * truth about what is coming up whatever the outbox no longer remembers.
 *
 * The reconciliation moves the cursor on once it has succeeded, because the
 * bot has caught up by another route and a cursor left stale would ask for the
 * same rebuild every morning. A reconciliation that failed leaves the cursor
 * where it was and stays pending, which the health endpoint reports.
 *
 * The third thing here happens once, at startup, rather than daily, and it is
 * about the posts the bot was still owing when it stopped. A delivery row that
 * was written and never posted is a post that has not been made, and for a row
 * that belongs to an outbox entry the only way to make it is to read that entry
 * again. So the bot moves the cursor back to just before the oldest entry it
 * still owes a post for. Everything between there and where the cursor stood
 * has already been posted, and the delivery rows that say so are what stop any
 * of it being posted a second time.
 */

/** How long the rows about what the bot did are kept, from section 10 of the design. */
export const RETENTION_DAYS = 90;

/** How long the web platform keeps an outbox entry before pruning it. */
export const OUTBOX_RETENTION_DAYS = 30;

/**
 * The campus hour this runs at. Four in the morning is the quietest hour of
 * the campus day, which is when to delete rows and to rebuild what a server
 * sees if it ever comes to that.
 */
export const HOUSEKEEPING_HOUR = 4;

export interface HousekeepingJobOptions {
  deliveries: Pick<Deliveries, 'pruneBefore' | 'pending'>;
  rateWindows: Pick<RateWindows, 'pruneBefore'>;
  cursors: OutboxCursors;
  guilds: GuildStore;
  /** What each server mirrors, which is what a reconciliation rebuilds. */
  mirror: Pick<ScheduledEventMirror, 'rollGuild'>;
  /** The cursor row to read, which the first release keeps at one. */
  consumer?: string;
  now?: () => Date;
  hour?: number;
  retentionDays?: number;
  outboxRetentionDays?: number;
}

/** What one run did, which is what the log reads. */
export interface HousekeepingResult {
  /** How many Deliveries rows went. */
  deliveries: number;
  /** How many Rate_Windows rows went. */
  rateWindows: number;
  /** How many servers were rebuilt from the reading endpoints. */
  reconciled: number;
  /** How many servers failed to rebuild, each of them logged. */
  failed: number;
}

/** What the housekeeping says about itself, for the health endpoint. */
export interface HousekeepingState {
  /** When the rows were last pruned, in campus wall clock, or null before the first run. */
  lastPruneAt: string | null;
  /**
   * Whether the bot knows it has fallen behind the outbox and has not yet
   * rebuilt what it mirrors. True is worth seeing: it means a server's Events
   * tab may be out of date until the next run succeeds.
   */
  reconciliationPending: boolean;
}

/** What one drain found, which is what the log at startup reads. */
export interface DrainResult {
  /** How many posts the bot was still owed. */
  owed: number;
  /** The outbox entry the cursor was moved back to, or null when it did not move. */
  rewoundTo: number | null;
}

export interface HousekeepingJob {
  run(hour: JobHour): Promise<HousekeepingResult>;
  /**
   * Ask the outbox again for the entries the bot still owes a post for. This
   * belongs to a startup rather than to the daily run: a bot that is running
   * retries an entry through the consumer's own attempts, and a bot that has
   * just come back has lost those and has only the delivery rows to go on.
   */
  drainPending(): Promise<DrainResult>;
  state(): HousekeepingState;
}

export function createHousekeepingJob(options: HousekeepingJobOptions): HousekeepingJob {
  const {
    deliveries,
    rateWindows,
    cursors,
    guilds,
    mirror,
    consumer = ANNOUNCEMENTS_CONSUMER,
    hour: runHour = HOUSEKEEPING_HOUR,
    retentionDays = RETENTION_DAYS,
    outboxRetentionDays = OUTBOX_RETENTION_DAYS,
  } = options;

  let lastPruneAt: string | null = null;
  let reconciliationPending = false;

  /**
   * Whether the cursor has fallen behind what the outbox still holds. A
   * consumer that has never read the outbox is not behind: there is nothing
   * for it to have missed.
   */
  async function behindTheOutbox(at: Date): Promise<boolean> {
    const state = await cursors.state(consumer);
    if (!state) return false;
    const movedAt = toInstant(state.updatedAt);
    if (!movedAt) return false;
    const oldest = toInstant(`${campusDatePlus(-outboxRetentionDays, at)} 00:00:00`);
    return oldest !== null && movedAt.getTime() < oldest.getTime();
  }

  /**
   * Rebuild what each server mirrors from the reading endpoints. Every server
   * is attempted, because one server whose Discord permissions have changed
   * must not stop the rest from being brought up to date.
   */
  async function reconcile(result: HousekeepingResult): Promise<void> {
    console.error(
      'the outbox cursor is older than the outbox retention, so the outbox can no longer be caught '
      + 'up with: rebuilding what every server mirrors from the reading endpoints',
    );

    for (const installation of await guilds.listInstallations()) {
      try {
        await mirror.rollGuild(installation);
        result.reconciled += 1;
      } catch (err) {
        result.failed += 1;
        console.error(
          `rebuilding what server ${installation.guildId} mirrors failed:`,
          (err as Error).message,
        );
      }
    }
  }

  return {
    async drainPending(): Promise<DrainResult> {
      const owed = await deliveries.pending();
      if (owed.length === 0) return { owed: 0, rewoundTo: null };

      console.log(`via-bot: ${owed.length} posts were still owed when the bot last stopped`);

      // A post owed for a digest, a reminder or a roll of the mirroring
      // window belongs to a job on a clock rather than to an outbox entry,
      // and that job makes it on its next pass without the outbox at all.
      const fromOutbox = owed.filter(row => row.outboxId !== NO_OUTBOX_ENTRY);
      if (fromOutbox.length === 0) return { owed: owed.length, rewoundTo: null };

      const oldest = Math.min(...fromOutbox.map(row => row.outboxId));
      const readFrom = oldest - 1;

      const state = await cursors.state(consumer);
      // Moving the cursor forward would skip entries nobody has handled, which
      // is the one thing this must never do.
      if (!state || state.lastOutboxId <= readFrom) return { owed: owed.length, rewoundTo: null };

      await cursors.advance(consumer, readFrom);
      console.log(
        `via-bot: reading the outbox again from entry ${oldest}, which is the oldest one `
        + 'carrying a post that was never made',
      );
      return { owed: owed.length, rewoundTo: readFrom };
    },

    async run(hour: JobHour): Promise<HousekeepingResult> {
      const result: HousekeepingResult = { deliveries: 0, rateWindows: 0, reconciled: 0, failed: 0 };
      if (hour.hour !== runHour) return result;

      const cutoffDay = campusDatePlus(-retentionDays, hour.at);
      const cutoff = `${cutoffDay} 00:00:00`;
      const cutoffInstant = toInstant(cutoff);

      result.deliveries = await deliveries.pruneBefore(cutoff);
      if (cutoffInstant) result.rateWindows = await rateWindows.pruneBefore(cutoffInstant);
      lastPruneAt = campusStamp(hour.at);

      if (await behindTheOutbox(hour.at)) {
        reconciliationPending = true;
        await reconcile(result);
        if (result.failed === 0) {
          // The bot has caught up by another route, so the cursor is moved on
          // to say so. Left where it was, it would ask for the same rebuild
          // every morning for as long as the outbox stayed quiet.
          const state = await cursors.state(consumer);
          if (state) await cursors.advance(consumer, state.lastOutboxId);
          reconciliationPending = false;
        }
      }

      console.log(
        `via-bot: housekeeping removed ${result.deliveries} deliveries and `
        + `${result.rateWindows} rate windows`,
      );
      return result;
    },

    state: () => ({ lastPruneAt, reconciliationPending }),
  };
}
