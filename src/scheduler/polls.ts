import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { schedulerPolls } from '../db/schema.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';
import type { ScheduleAsk } from './proposal.ts';

/**
 * The polls the scheduler opened.
 *
 * Discord counts the votes and holds the answers, and this holds the two
 * things Discord cannot: which evening each answer stood for, so that the
 * winning answer can be turned back into a time and a room, and what was asked
 * of the scheduler, so that accepting can ask the same question again before
 * anything is created.
 *
 * It also holds when the poll closes. Discord sends no event of its own to say
 * that a poll has ended, and the only gateway signal near it is the message
 * being edited when the counts are finalized, which the bot would have to ask
 * for every message in every server to see. So the bot writes down the hour a
 * poll runs to and goes and reads the result then, which needs no intent at
 * all and survives a restart in the middle of a poll.
 */

/** One evening a poll offered, in the order Discord holds its answers. */
export interface PolledCandidate {
  /** Campus wall clock, as YYYY-MM-DDTHH:MM, which is what a button carries. */
  startTime: string;
  locationId: number | null;
  building: string | null;
  roomNumber: string | null;
  score: number;
  intervalWeeks: number;
  until: string;
  /** The answer as the poll shows it, which the result message reads back. */
  answer: string;
}

export interface NewSchedulerPoll {
  guildId: string;
  channelId: string;
  messageId: string;
  rsoId: number;
  openedBy: string;
  ask: ScheduleAsk;
  candidates: PolledCandidate[];
  /** The campus wall clock the bot goes and reads the result at. */
  closesAt: string;
}

export interface SchedulerPoll extends NewSchedulerPoll {
  pollId: number;
  /** When the result was posted, which is what stops it being posted twice. */
  closedAt: string | null;
}

export interface SchedulerPolls {
  /** Write down a poll that has just been posted. */
  open(poll: NewSchedulerPoll): Promise<SchedulerPoll>;
  get(pollId: number): Promise<SchedulerPoll | null>;
  /** Every poll whose time is up and whose result has not been posted, oldest first. */
  due(at: string): Promise<SchedulerPoll[]>;
  recordClosed(pollId: number, at: string): Promise<void>;
  /** Forget every poll a server holds, which removal calls. */
  removeGuild(guildId: string): Promise<number>;
}

function present(row: typeof schedulerPolls.$inferSelect): SchedulerPoll {
  return {
    pollId: row.pollId,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    rsoId: row.rsoId,
    openedBy: row.openedBy,
    ask: row.request as ScheduleAsk,
    candidates: (row.candidates ?? []) as PolledCandidate[],
    closesAt: row.closesAt,
    closedAt: row.closedAt ?? null,
  };
}

export function createSchedulerPolls(db: BotDatabase): SchedulerPolls {
  async function get(pollId: number): Promise<SchedulerPoll | null> {
    const [row] = await db.select().from(schedulerPolls)
      .where(eq(schedulerPolls.pollId, pollId));
    return row ? present(row) : null;
  }

  return {
    async open(poll) {
      await db.insert(schedulerPolls).values({
        guildId: poll.guildId,
        channelId: poll.channelId,
        messageId: poll.messageId,
        rsoId: poll.rsoId,
        openedBy: poll.openedBy,
        request: poll.ask,
        candidates: poll.candidates,
        closesAt: poll.closesAt,
      });

      // The identifier is the database's, so it is read back rather than
      // guessed, which is also what proves the row is there.
      const [row] = await db.select().from(schedulerPolls).where(and(
        eq(schedulerPolls.guildId, poll.guildId),
        eq(schedulerPolls.messageId, poll.messageId),
      ));
      return present(row!);
    },

    get,

    async due(at) {
      const rows = await db.select().from(schedulerPolls)
        .where(and(isNull(schedulerPolls.closedAt), lte(schedulerPolls.closesAt, at)))
        .orderBy(asc(schedulerPolls.closesAt));
      return rows.map(present);
    },

    async recordClosed(pollId, at) {
      await db.update(schedulerPolls).set({ closedAt: at })
        .where(eq(schedulerPolls.pollId, pollId));
    },

    async removeGuild(guildId) {
      const rows = await db.select().from(schedulerPolls)
        .where(eq(schedulerPolls.guildId, guildId));
      await db.delete(schedulerPolls).where(eq(schedulerPolls.guildId, guildId));
      return rows.length;
    },
  };
}
