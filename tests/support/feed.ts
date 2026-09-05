import {
  DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR, DEFAULT_REMINDER_LEAD_MINUTES,
  type FeedPreferenceChanges, type FeedPreferences, type FeedStore, type Follows, type ReminderRow,
} from '../../src/feed/store.ts';
import type { InterestMarks } from '../../src/feed/interestMarks.ts';

/**
 * The personal feed in memory.
 *
 * What the tables guarantee is tested against a real database in
 * tests/db/feedStore.db.test.ts, so what the commands and the jobs need here
 * is behaviour they can read back: who follows what, what each person chose,
 * and which reminders are outstanding.
 */
export function memoryFeedStore(): FeedStore & { preferenceRows: () => FeedPreferences[] } {
  const follows = new Map<string, Set<number>>();
  const preferences = new Map<string, FeedPreferences>();
  const reminders: ReminderRow[] = [];
  const courses = new Map<string, Set<string>>();
  let nextReminderId = 1;

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

  function row(discordUserId: string): FeedPreferences {
    if (!preferences.has(discordUserId)) preferences.set(discordUserId, defaults(discordUserId));
    return preferences.get(discordUserId)!;
  }

  function followsOf(discordUserId: string): Set<number> {
    if (!follows.has(discordUserId)) follows.set(discordUserId, new Set());
    return follows.get(discordUserId)!;
  }

  function coursesOf(discordUserId: string): Set<string> {
    if (!courses.has(discordUserId)) courses.set(discordUserId, new Set());
    return courses.get(discordUserId)!;
  }

  return {
    preferenceRows: () => [...preferences.values()].map(held => ({ ...held })),

    async follows(discordUserId: string): Promise<Follows> {
      return {
        all: (preferences.get(discordUserId)?.followAll) ?? false,
        rsoIds: [...followsOf(discordUserId)].sort((left, right) => left - right),
      };
    },

    async follow(discordUserId: string, rsoId: number): Promise<boolean> {
      row(discordUserId);
      const held = followsOf(discordUserId);
      if (held.has(rsoId)) return false;
      held.add(rsoId);
      return true;
    },

    async unfollow(discordUserId: string, rsoId: number): Promise<boolean> {
      return followsOf(discordUserId).delete(rsoId);
    },

    async setFollowAll(discordUserId: string, all: boolean): Promise<void> {
      row(discordUserId).followAll = all;
    },

    async preferences(discordUserId: string): Promise<FeedPreferences> {
      return { ...(preferences.get(discordUserId) ?? defaults(discordUserId)) };
    },

    async savePreferences(discordUserId: string, changes: FeedPreferenceChanges): Promise<FeedPreferences> {
      Object.assign(row(discordUserId), changes);
      return { ...row(discordUserId) };
    },

    async digestDueAt(dayOfWeek: number, hour: number): Promise<FeedPreferences[]> {
      return [...preferences.values()]
        .filter(held => held.digestDay === dayOfWeek && held.digestHour === hour)
        .filter(held => !held.directMessageOptOut)
        .map(held => ({ ...held }));
    },

    async addReminder(discordUserId: string, eventId: number, remindAt: string): Promise<boolean> {
      row(discordUserId);
      const held = reminders.find(one => one.discordUserId === discordUserId && one.eventId === eventId);
      if (held) {
        held.remindAt = remindAt;
        return false;
      }
      reminders.push({ reminderId: nextReminderId++, discordUserId, eventId, remindAt });
      return true;
    },

    async listReminders(discordUserId: string): Promise<ReminderRow[]> {
      return reminders
        .filter(one => one.discordUserId === discordUserId)
        .sort((left, right) => left.remindAt.localeCompare(right.remindAt))
        .map(one => ({ ...one }));
    },

    async outstandingReminders(): Promise<ReminderRow[]> {
      return reminders
        .slice()
        .sort((left, right) => left.reminderId - right.reminderId)
        .map(one => ({ ...one }));
    },

    async dueReminders(at: string, limit = 200): Promise<ReminderRow[]> {
      return reminders
        .filter(one => one.remindAt <= at)
        .sort((left, right) => left.remindAt.localeCompare(right.remindAt))
        .slice(0, limit)
        .map(one => ({ ...one }));
    },

    async removeReminder(reminderId: number): Promise<void> {
      const at = reminders.findIndex(one => one.reminderId === reminderId);
      if (at >= 0) reminders.splice(at, 1);
    },

    async removeReminderFor(discordUserId: string, eventId: number): Promise<boolean> {
      const at = reminders.findIndex(one => one.discordUserId === discordUserId && one.eventId === eventId);
      if (at < 0) return false;
      reminders.splice(at, 1);
      return true;
    },

    async courses(discordUserId: string): Promise<string[]> {
      return [...coursesOf(discordUserId)].sort();
    },

    async addCourse(discordUserId: string, courseCode: string): Promise<boolean> {
      row(discordUserId);
      const held = coursesOf(discordUserId);
      if (held.has(courseCode)) return false;
      held.add(courseCode);
      return true;
    },

    async removeCourse(discordUserId: string, courseCode: string): Promise<boolean> {
      return coursesOf(discordUserId).delete(courseCode);
    },

    async courseFollowers(courseCode: string): Promise<string[]> {
      return [...courses.entries()]
        .filter(([, held]) => held.has(courseCode))
        .map(([discordUserId]) => discordUserId)
        .sort();
    },
  };
}

/**
 * Interest_Marks in memory. What the table guarantees is tested against a real
 * database in tests/db/interestMarks.db.test.ts, so what the feedback job
 * needs here is behaviour: who marked interest in what, and rows that go once
 * the feedback for an event has been asked for.
 */
export function memoryInterestMarks(): InterestMarks {
  const rows = new Set<string>();
  const key = (eventId: number, discordUserId: string) => `${eventId}|${discordUserId}`;
  const parts = (held: string) => held.split('|') as [string, string];

  return {
    async mark(eventId: number, discordUserId: string): Promise<boolean> {
      const held = key(eventId, discordUserId);
      if (rows.has(held)) return false;
      rows.add(held);
      return true;
    },

    async unmark(eventId: number, discordUserId: string): Promise<boolean> {
      return rows.delete(key(eventId, discordUserId));
    },

    async listPeople(eventId: number): Promise<string[]> {
      return [...rows]
        .map(parts)
        .filter(([held]) => Number(held) === eventId)
        .map(([, discordUserId]) => discordUserId)
        .sort();
    },

    async listEvents(): Promise<number[]> {
      return [...new Set([...rows].map(held => Number(parts(held)[0])))]
        .sort((left, right) => left - right);
    },

    async clearEvent(eventId: number): Promise<number> {
      const held = [...rows].filter(one => Number(parts(one)[0]) === eventId);
      for (const one of held) rows.delete(one);
      return held.length;
    },

    async removeForUser(discordUserId: string): Promise<number> {
      const held = [...rows].filter(one => parts(one)[1] === discordUserId);
      for (const one of held) rows.delete(one);
      return held.length;
    },
  };
}
