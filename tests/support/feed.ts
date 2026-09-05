import {
  DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR, DEFAULT_REMINDER_LEAD_MINUTES,
  type FeedPreferenceChanges, type FeedPreferences, type FeedStore, type Follows, type ReminderRow,
} from '../../src/feed/store.ts';

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
