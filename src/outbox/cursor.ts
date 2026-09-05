import { eq } from 'drizzle-orm';
import { outboxCursor } from '../db/schema.ts';
import { campusStamp } from '../render/campusTime.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * How far through the outbox the bot has read.
 *
 * The outbox endpoint is stateless: the web platform keeps nothing about what
 * the bot has seen, which is what lets a second consumer appear later without
 * a change on either side. The cursor is therefore the bot's own, and it is a
 * row rather than a variable, because a bot that restarts has to carry on
 * from the entry it finished rather than from the beginning of the outbox.
 *
 * The cursor is advanced only after every delivery for an entry is recorded,
 * which is what makes the outbox at least once from the web platform and
 * exactly once into Discord under any single failure.
 */

/** The consumer the first release runs, which is the one that announces. */
export const ANNOUNCEMENTS_CONSUMER = 'announcements';

/** Where a consumer that has never read the outbox starts. */
export const START_OF_OUTBOX = 0;

export interface OutboxCursors {
  /** The last entry this consumer finished, or the start of the outbox. */
  read(consumer: string): Promise<number>;
  /** Record that this consumer has finished everything up to and including an entry. */
  advance(consumer: string, lastOutboxId: number): Promise<void>;
}

export interface OutboxCursorOptions {
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export function createOutboxCursors(db: BotDatabase, options: OutboxCursorOptions = {}): OutboxCursors {
  const { now = () => new Date() } = options;

  return {
    async read(consumer: string): Promise<number> {
      const [row] = await db.select().from(outboxCursor)
        .where(eq(outboxCursor.consumer, consumer));
      return row ? row.lastOutboxId : START_OF_OUTBOX;
    },

    /**
     * One consumer reads the outbox in order, so the cursor is written as it
     * is given rather than compared with what is there. Two consumers of the
     * same name would be two bots against one database, which the deployment
     * does not have.
     */
    async advance(consumer: string, lastOutboxId: number): Promise<void> {
      const updatedAt = campusStamp(now());
      await db.insert(outboxCursor)
        .values({ consumer, lastOutboxId, updatedAt })
        .onDuplicateKeyUpdate({ set: { lastOutboxId, updatedAt } });
    },
  };
}
