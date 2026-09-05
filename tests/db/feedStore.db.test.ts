import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let userPreferences: typeof import('../../src/db/schema.ts').userPreferences;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createFeedStore: typeof import('../../src/feed/store.ts').createFeedStore;
let DEFAULT_DIGEST_DAY: number;
let DEFAULT_DIGEST_HOUR: number;

/**
 * The personal feed, in the three tables that hold it.
 *
 * Subscriptions says which organizations a person follows, User_Preferences
 * says when the bot may write to them and how, and Reminders holds the one off
 * reminders they asked for from an event card. What the jobs need from all
 * three is a question the database answers rather than one the bot works out
 * in memory: who is due a digest in this hour, and which reminders have come
 * due.
 */
describe('the personal feed', () => {
  const ADA = '204255221017214977';
  const GRACE = '204255221017214978';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ userPreferences } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createFeedStore, DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR } = await import('../../src/feed/store.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  const store = () => createFeedStore(db, { now: () => new Date('2026-09-05T14:30:00Z') });

  describe('following', () => {
    it('has nobody following anything to begin with', async () => {
      expect(await store().follows(ADA)).toEqual({ all: false, rsoIds: [] });
    });

    it('records a follow once, however many times it is asked for', async () => {
      expect(await store().follow(ADA, 3)).toBe(true);
      expect(await store().follow(ADA, 3)).toBe(false);
      expect(await store().follows(ADA)).toEqual({ all: false, rsoIds: [3] });
    });

    it('keeps one person follows apart from another person follows', async () => {
      await store().follow(ADA, 3);
      await store().follow(GRACE, 7);
      expect((await store().follows(ADA)).rsoIds).toEqual([3]);
      expect((await store().follows(GRACE)).rsoIds).toEqual([7]);
    });

    it('says whether there was anything to unfollow', async () => {
      await store().follow(ADA, 3);
      expect(await store().unfollow(ADA, 3)).toBe(true);
      expect(await store().unfollow(ADA, 3)).toBe(false);
      expect((await store().follows(ADA)).rsoIds).toEqual([]);
    });

    /**
     * Following everything is a flag rather than a row per organization, so
     * that an organization created tomorrow is followed too.
     */
    it('follows everything without naming a single organization', async () => {
      await store().setFollowAll(ADA, true);
      expect(await store().follows(ADA)).toEqual({ all: true, rsoIds: [] });
      await store().setFollowAll(ADA, false);
      expect(await store().follows(ADA)).toEqual({ all: false, rsoIds: [] });
    });

    it('writes the preferences row when somebody first follows, so that the digest can find them', async () => {
      await store().follow(ADA, 3);
      const rows = await db.select().from(userPreferences);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.discordUserId).toBe(ADA);
    });
  });

  describe('preferences', () => {
    it('answers with the defaults for somebody who has never chosen', async () => {
      expect(await store().preferences(ADA)).toEqual({
        discordUserId: ADA,
        digestDay: DEFAULT_DIGEST_DAY,
        digestHour: DEFAULT_DIGEST_HOUR,
        reminderLeadMinutes: 60,
        followAll: false,
        feedbackOptOut: false,
        directMessageOptOut: false,
      });
    });

    it('keeps what a person chose, and leaves the rest alone', async () => {
      await store().savePreferences(ADA, { digestDay: 3, digestHour: 9 });
      await store().savePreferences(ADA, { reminderLeadMinutes: 120 });

      const held = await store().preferences(ADA);
      expect(held.digestDay).toBe(3);
      expect(held.digestHour).toBe(9);
      expect(held.reminderLeadMinutes).toBe(120);
    });

    it('records the two opt outs', async () => {
      await store().savePreferences(ADA, { directMessageOptOut: true, feedbackOptOut: true });
      const held = await store().preferences(ADA);
      expect(held.directMessageOptOut).toBe(true);
      expect(held.feedbackOptOut).toBe(true);
    });
  });

  describe('who is due a digest', () => {
    it('finds the people whose chosen day and hour this is', async () => {
      await store().follow(ADA, 3);
      await store().savePreferences(ADA, { digestDay: 1, digestHour: 9 });
      await store().follow(GRACE, 3);
      await store().savePreferences(GRACE, { digestDay: 2, digestHour: 9 });

      const due = await store().digestDueAt(1, 9);
      expect(due.map(person => person.discordUserId)).toEqual([ADA]);
    });

    it('finds the people who never chose, at the default day and hour', async () => {
      await store().follow(ADA, 3);
      const due = await store().digestDueAt(DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR);
      expect(due.map(person => person.discordUserId)).toEqual([ADA]);
    });

    it('leaves out somebody who has turned the direct messages off', async () => {
      await store().follow(ADA, 3);
      await store().savePreferences(ADA, { directMessageOptOut: true });
      expect(await store().digestDueAt(DEFAULT_DIGEST_DAY, DEFAULT_DIGEST_HOUR)).toEqual([]);
    });
  });

  describe('reminders', () => {
    it('holds one reminder per person and event', async () => {
      expect(await store().addReminder(ADA, 10, '2026-09-10 17:00:00')).toBe(true);
      expect(await store().addReminder(ADA, 10, '2026-09-10 16:00:00')).toBe(false);

      const held = await store().listReminders(ADA);
      expect(held).toHaveLength(1);
      // The second answer moves the reminder rather than adding another, which
      // is what somebody who changed their lead time expects.
      expect(held[0]!.remindAt).toBe('2026-09-10 16:00:00');
    });

    it('answers with the reminders that have come due, oldest first', async () => {
      await store().addReminder(ADA, 10, '2026-09-05 08:00:00');
      await store().addReminder(ADA, 11, '2026-09-05 09:00:00');
      await store().addReminder(GRACE, 12, '2026-09-06 09:00:00');

      const due = await store().dueReminders('2026-09-05 09:30:00');
      expect(due.map(row => row.eventId)).toEqual([10, 11]);
    });

    it('forgets a reminder once it has been sent', async () => {
      await store().addReminder(ADA, 10, '2026-09-05 08:00:00');
      const [due] = await store().dueReminders('2026-09-05 09:30:00');
      await store().removeReminder(due!.reminderId);
      expect(await store().dueReminders('2026-09-05 09:30:00')).toEqual([]);
    });

    it('says whether there was a reminder to take back', async () => {
      await store().addReminder(ADA, 10, '2026-09-05 08:00:00');
      expect(await store().removeReminderFor(ADA, 10)).toBe(true);
      expect(await store().removeReminderFor(ADA, 10)).toBe(false);
    });
  });
});
