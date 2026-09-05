import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { reminders, subscriptions, userPreferences } from '../db/schema.ts';
import { campusStamp } from '../render/campusTime.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * The personal feed.
 *
 * Three tables hold what one person asked the bot for. Subscriptions says
 * which organizations they follow, User_Preferences says when the bot may
 * write to them and how, and Reminders holds the one off reminders they asked
 * for from an event card. They are one module because they are one thing: a
 * person's feed, which the follow commands write and the digest and reminder
 * jobs read.
 *
 * Two decisions are worth stating. Following everything is a flag on
 * User_Preferences rather than a row per organization, so that an organization
 * created tomorrow is followed too. And a day and an hour that nobody has
 * chosen are read as the defaults rather than as an absence, because somebody
 * who followed an organization has asked to hear about it and a digest that
 * waits for a second choice would never arrive. Every direct message the bot
 * sends carries the way to stop it, which is what makes a default safe.
 */

/** The day of the week a digest arrives on when nobody has chosen one, which is Sunday. */
export const DEFAULT_DIGEST_DAY = 0;

/** The hour a digest arrives at when nobody has chosen one, which is six in the evening. */
export const DEFAULT_DIGEST_HOUR = 18;

/** How far ahead a reminder arrives when nobody has chosen, which is an hour. */
export const DEFAULT_REMINDER_LEAD_MINUTES = 60;

/** How many reminders one pass of the reminder job takes at a time. */
export const REMINDER_BATCH = 200;

/** What one person asked the bot to do on its own. */
export interface FeedPreferences {
  discordUserId: string;
  /** The day of the week the digest arrives on, zero for Sunday. */
  digestDay: number;
  /** The hour on the campus clock the digest arrives at. */
  digestHour: number;
  reminderLeadMinutes: number;
  followAll: boolean;
  feedbackOptOut: boolean;
  directMessageOptOut: boolean;
}

/** What a person may change about their feed. */
export type FeedPreferenceChanges = Partial<Omit<FeedPreferences, 'discordUserId'>>;

/** What somebody follows: every organization, or the ones they named. */
export interface Follows {
  all: boolean;
  rsoIds: number[];
}

/** One reminder somebody asked for, as the reminder job reads it. */
export interface ReminderRow {
  reminderId: number;
  discordUserId: string;
  eventId: number;
  /** When the reminder is due, in campus wall clock. */
  remindAt: string;
}

export interface FeedStoreOptions {
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export interface FeedStore {
  /** What one person follows. */
  follows(discordUserId: string): Promise<Follows>;
  /** Follow one organization, answering whether this is new. */
  follow(discordUserId: string, rsoId: number): Promise<boolean>;
  /** Stop following one organization, answering whether there was anything to stop. */
  unfollow(discordUserId: string, rsoId: number): Promise<boolean>;
  /** Follow every organization in ECE, or stop. */
  setFollowAll(discordUserId: string, all: boolean): Promise<void>;
  /** What one person chose, with the defaults filled in for anything they did not. */
  preferences(discordUserId: string): Promise<FeedPreferences>;
  /** Change what a person chose, leaving everything they did not name alone. */
  savePreferences(discordUserId: string, changes: FeedPreferenceChanges): Promise<FeedPreferences>;
  /**
   * Everybody whose digest falls in this campus day and hour and who accepts
   * direct messages. Whether they follow anything is the job's question, not
   * this one, because the answer to it is a call to the web platform.
   */
  digestDueAt(dayOfWeek: number, hour: number): Promise<FeedPreferences[]>;
  /** Ask for a reminder, answering whether this is new rather than a change of time. */
  addReminder(discordUserId: string, eventId: number, remindAt: string): Promise<boolean>;
  listReminders(discordUserId: string): Promise<ReminderRow[]>;
  /** The reminders that have come due at a campus wall clock time, oldest first. */
  dueReminders(at: string, limit?: number): Promise<ReminderRow[]>;
  removeReminder(reminderId: number): Promise<void>;
  /** Take back a reminder somebody asked for, answering whether there was one. */
  removeReminderFor(discordUserId: string, eventId: number): Promise<boolean>;
}

/** MySQL's code for a row that a unique key refused. */
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function isDuplicate(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } });
  return code?.code === DUPLICATE_ENTRY || code?.cause?.code === DUPLICATE_ENTRY;
}

function present(row: typeof userPreferences.$inferSelect): FeedPreferences {
  return {
    discordUserId: row.discordUserId,
    digestDay: row.digestDay ?? DEFAULT_DIGEST_DAY,
    digestHour: row.digestHour ?? DEFAULT_DIGEST_HOUR,
    reminderLeadMinutes: row.reminderLeadMinutes,
    followAll: Boolean(row.followAll),
    feedbackOptOut: Boolean(row.feedbackOptOut),
    directMessageOptOut: Boolean(row.directMessageOptOut),
  };
}

/** What somebody who has never chosen anything has. */
function defaults(discordUserId: string): FeedPreferences {
  return {
    discordUserId,
    digestDay: DEFAULT_DIGEST_DAY,
    digestHour: DEFAULT_DIGEST_HOUR,
    reminderLeadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
    followAll: false,
    feedbackOptOut: false,
    directMessageOptOut: false,
  };
}

function presentReminder(row: typeof reminders.$inferSelect): ReminderRow {
  return {
    reminderId: row.reminderId,
    discordUserId: row.discordUserId,
    eventId: row.eventId,
    remindAt: row.remindAt,
  };
}

export function createFeedStore(db: BotDatabase, options: FeedStoreOptions = {}): FeedStore {
  const { now = () => new Date() } = options;

  /**
   * Make sure the person has a preferences row.
   *
   * The digest job asks the database which people are due in this hour, and a
   * person with no row is a person that question cannot find. Following is the
   * moment somebody asks to hear from the bot, so it is the moment the row is
   * written, with every default left as it is.
   */
  async function ensureRow(discordUserId: string): Promise<void> {
    await db.insert(userPreferences)
      .values({ discordUserId })
      .onDuplicateKeyUpdate({ set: { discordUserId } });
  }

  async function preferences(discordUserId: string): Promise<FeedPreferences> {
    const [row] = await db.select().from(userPreferences)
      .where(eq(userPreferences.discordUserId, discordUserId));
    return row ? present(row) : defaults(discordUserId);
  }

  return {
    preferences,

    async follows(discordUserId: string): Promise<Follows> {
      const [held, rows] = await Promise.all([
        preferences(discordUserId),
        db.select().from(subscriptions).where(eq(subscriptions.discordUserId, discordUserId)),
      ]);
      return {
        all: held.followAll,
        rsoIds: rows.map(row => row.rsoId).sort((left, right) => left - right),
      };
    },

    async follow(discordUserId: string, rsoId: number): Promise<boolean> {
      await ensureRow(discordUserId);
      try {
        await db.insert(subscriptions)
          .values({ discordUserId, rsoId, createdAt: campusStamp(now()) });
        return true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        return false;
      }
    },

    async unfollow(discordUserId: string, rsoId: number): Promise<boolean> {
      const held = await db.select().from(subscriptions).where(and(
        eq(subscriptions.discordUserId, discordUserId),
        eq(subscriptions.rsoId, rsoId),
      ));
      if (held.length === 0) return false;
      await db.delete(subscriptions).where(and(
        eq(subscriptions.discordUserId, discordUserId),
        eq(subscriptions.rsoId, rsoId),
      ));
      return true;
    },

    async setFollowAll(discordUserId: string, all: boolean): Promise<void> {
      await db.insert(userPreferences)
        .values({ discordUserId, followAll: all })
        .onDuplicateKeyUpdate({ set: { followAll: all } });
    },

    async savePreferences(discordUserId: string, changes: FeedPreferenceChanges): Promise<FeedPreferences> {
      await db.insert(userPreferences)
        .values({ discordUserId, ...changes })
        .onDuplicateKeyUpdate({ set: { ...changes } });
      return preferences(discordUserId);
    },

    /**
     * A day or an hour nobody chose is the default, so the condition has to
     * match both the people who chose this hour and the people who chose
     * nothing at all, in the hour the default falls in.
     */
    async digestDueAt(dayOfWeek: number, hour: number): Promise<FeedPreferences[]> {
      const dayMatches = dayOfWeek === DEFAULT_DIGEST_DAY
        ? or(eq(userPreferences.digestDay, dayOfWeek), isNull(userPreferences.digestDay))
        : eq(userPreferences.digestDay, dayOfWeek);
      const hourMatches = hour === DEFAULT_DIGEST_HOUR
        ? or(eq(userPreferences.digestHour, hour), isNull(userPreferences.digestHour))
        : eq(userPreferences.digestHour, hour);

      const rows = await db.select().from(userPreferences).where(and(
        dayMatches,
        hourMatches,
        eq(userPreferences.directMessageOptOut, false),
      ));
      return rows.map(present);
    },

    /**
     * A reminder asked for twice is one reminder. The second answer moves it
     * rather than adding another, because somebody who changed their lead time
     * and pressed the button again is asking for one reminder at a new time.
     */
    async addReminder(discordUserId: string, eventId: number, remindAt: string): Promise<boolean> {
      await ensureRow(discordUserId);
      try {
        await db.insert(reminders)
          .values({ discordUserId, eventId, remindAt, createdAt: campusStamp(now()) });
        return true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        await db.update(reminders).set({ remindAt }).where(and(
          eq(reminders.discordUserId, discordUserId),
          eq(reminders.eventId, eventId),
        ));
        return false;
      }
    },

    async listReminders(discordUserId: string): Promise<ReminderRow[]> {
      const rows = await db.select().from(reminders)
        .where(eq(reminders.discordUserId, discordUserId))
        .orderBy(asc(reminders.remindAt));
      return rows.map(presentReminder);
    },

    async dueReminders(at: string, limit: number = REMINDER_BATCH): Promise<ReminderRow[]> {
      const rows = await db.select().from(reminders)
        .where(lte(reminders.remindAt, at))
        .orderBy(asc(reminders.remindAt))
        .limit(limit);
      return rows.map(presentReminder);
    },

    async removeReminder(reminderId: number): Promise<void> {
      await db.delete(reminders).where(eq(reminders.reminderId, reminderId));
    },

    async removeReminderFor(discordUserId: string, eventId: number): Promise<boolean> {
      const held = await db.select().from(reminders).where(and(
        eq(reminders.discordUserId, discordUserId),
        eq(reminders.eventId, eventId),
      ));
      if (held.length === 0) return false;
      await db.delete(reminders).where(eq(reminders.reminderId, held[0]!.reminderId));
      return true;
    },
  };
}
