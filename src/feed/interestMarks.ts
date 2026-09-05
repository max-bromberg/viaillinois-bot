import { and, asc, eq } from 'drizzle-orm';
import { interestMarks } from '../db/schema.ts';
import { campusStamp } from '../render/campusTime.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * Who marked interest in an event, by Discord account.
 *
 * The feedback request of section 6.4 goes to the people who marked interest
 * in an event or asked to be reminded of it. The bot knows who asked to be
 * reminded, because Reminders is its own table, but interest is recorded on
 * the web platform, which holds it by NetID for a linked person and by a
 * salted hash for everybody else. Neither of those can be turned back into a
 * Discord account, and section 7 of the design says the bot never stores a
 * NetID, so the bot keeps its own record of the marks it forwarded: one row
 * per event and Discord account.
 *
 * The record holds nothing the bot did not already handle. It is written where
 * interest is forwarded to the web platform, which is the event card's
 * Interested button and the control on a mirrored scheduled event, and it is
 * deleted when interest is withdrawn. The rows for an event go once the
 * feedback for it has been asked for, and the rows of a person go when they
 * unlink, along with everything else the bot held for them.
 */

export interface InterestMarksOptions {
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export interface InterestMarks {
  /** Write down that somebody marked interest, answering whether it is new. */
  mark(eventId: number, discordUserId: string): Promise<boolean>;
  /** Forget a mark, answering whether there was one to forget. */
  unmark(eventId: number, discordUserId: string): Promise<boolean>;
  /**
   * Whether one person has a mark on one event, which is what the Interested
   * button asks before it decides which way it is being pressed.
   */
  hasMark(eventId: number, discordUserId: string): Promise<boolean>;
  /** The Discord accounts that marked interest in one event. */
  listPeople(eventId: number): Promise<string[]>;
  /** Every event anybody has an outstanding mark on, oldest identifier first. */
  listEvents(): Promise<number[]>;
  /** Forget every mark on one event, answering how many there were. */
  clearEvent(eventId: number): Promise<number>;
  /** Forget every mark one person left, answering how many there were. */
  removeForUser(discordUserId: string): Promise<number>;
}

/** MySQL's code for a row that a unique key refused. */
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function isDuplicate(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } });
  return code?.code === DUPLICATE_ENTRY || code?.cause?.code === DUPLICATE_ENTRY;
}

export function createInterestMarks(db: BotDatabase, options: InterestMarksOptions = {}): InterestMarks {
  const { now = () => new Date() } = options;

  return {
    /**
     * The insert is tried and the refusal of the primary key is read, rather
     * than a read followed by an insert. Somebody pressing the same button
     * twice in two servers is one mark either way, and a read first would be a
     * race with a window in it.
     */
    async mark(eventId: number, discordUserId: string): Promise<boolean> {
      try {
        await db.insert(interestMarks)
          .values({ eventId, discordUserId, markedAt: campusStamp(now()) });
        return true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        return false;
      }
    },

    async unmark(eventId: number, discordUserId: string): Promise<boolean> {
      const held = await db.select().from(interestMarks).where(and(
        eq(interestMarks.eventId, eventId),
        eq(interestMarks.discordUserId, discordUserId),
      ));
      if (held.length === 0) return false;
      await db.delete(interestMarks).where(and(
        eq(interestMarks.eventId, eventId),
        eq(interestMarks.discordUserId, discordUserId),
      ));
      return true;
    },

    async hasMark(eventId: number, discordUserId: string): Promise<boolean> {
      const [row] = await db.select().from(interestMarks).where(and(
        eq(interestMarks.eventId, eventId),
        eq(interestMarks.discordUserId, discordUserId),
      ));
      return Boolean(row);
    },

    async listPeople(eventId: number): Promise<string[]> {
      const rows = await db.select().from(interestMarks)
        .where(eq(interestMarks.eventId, eventId))
        .orderBy(asc(interestMarks.discordUserId));
      return rows.map(row => row.discordUserId);
    },

    async listEvents(): Promise<number[]> {
      const rows = await db.selectDistinct({ eventId: interestMarks.eventId })
        .from(interestMarks)
        .orderBy(asc(interestMarks.eventId));
      return rows.map(row => row.eventId);
    },

    async clearEvent(eventId: number): Promise<number> {
      const held = await db.select().from(interestMarks).where(eq(interestMarks.eventId, eventId));
      if (held.length === 0) return 0;
      await db.delete(interestMarks).where(eq(interestMarks.eventId, eventId));
      return held.length;
    },

    async removeForUser(discordUserId: string): Promise<number> {
      const held = await db.select().from(interestMarks)
        .where(eq(interestMarks.discordUserId, discordUserId));
      if (held.length === 0) return 0;
      await db.delete(interestMarks).where(eq(interestMarks.discordUserId, discordUserId));
      return held.length;
    },
  };
}
