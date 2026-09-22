import { describe, it, expect, beforeEach } from 'vitest';
import { createOptInHandlers, createOptInReporter } from '../../src/feed/optIns.ts';
import { memoryFeedStore } from '../support/feed.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';

/**
 * The two choices a person can now make on the website as well as here.
 *
 * Following an organization and asking for a reminder belong to the bot,
 * because the bot is what sends the message. The website cannot reach the
 * tables they live in, so a choice made there arrives through the outbox and is
 * applied here, and what the bot holds is reported back so that the website
 * shows the same answer whichever side it was chosen on.
 */
describe('a choice made on the website', () => {
  const PERSON = '204255221017214977';
  let feed: ReturnType<typeof memoryFeedStore>;
  let via: ReturnType<typeof createFakeViaClient>;

  beforeEach(() => {
    feed = memoryFeedStore();
    via = createFakeViaClient();
  });

  const handle = (payload: Record<string, unknown>) =>
    createOptInHandlers({ feed, via })['optin.changed']({
      outboxId: 7, kind: 'optin.changed', subjectType: String(payload.subject ?? ''),
      subjectId: String(payload.subject_id ?? ''), rsoId: null, payload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  it('follows the organization somebody followed on the website', async () => {
    await handle({ discord_user_id: PERSON, subject: 'rso', subject_id: 4, wanted: true });
    expect((await feed.follows(PERSON)).rsoIds).toContain(4);
  });

  it('stops following the one they stopped following there', async () => {
    await feed.follow(PERSON, 4);
    await handle({ discord_user_id: PERSON, subject: 'rso', subject_id: 4, wanted: false });
    expect((await feed.follows(PERSON)).rsoIds).not.toContain(4);
  });

  /**
   * A reminder is due at a time rather than simply existing, and the website
   * does not know when: the lead is the person's own preference and the start
   * is the event's. So the bot reads both and works out the moment itself.
   */
  it('works out when a reminder is due from the event and the person\'s lead', async () => {
    via.seedEvent({ eventId: 12, startTime: '2026-09-21 18:00:00' });
    await feed.savePreferences(PERSON, { reminderLeadMinutes: 120 });

    await handle({ discord_user_id: PERSON, subject: 'event', subject_id: 12, wanted: true });

    const [reminder] = await feed.listReminders(PERSON);
    expect(reminder.eventId).toBe(12);
    expect(reminder.remindAt).toBe('2026-09-21 16:00:00');
  });

  it('withdraws a reminder somebody withdrew on the website', async () => {
    via.seedEvent({ eventId: 12, startTime: '2026-09-21 18:00:00' });
    await handle({ discord_user_id: PERSON, subject: 'event', subject_id: 12, wanted: true });
    await handle({ discord_user_id: PERSON, subject: 'event', subject_id: 12, wanted: false });

    expect(await feed.listReminders(PERSON)).toEqual([]);
  });

  /**
   * An event the bot cannot read is one it cannot work out a time for, and a
   * reminder with no time would either never arrive or arrive at once. The
   * instruction is left rather than guessed at.
   */
  it('sets no reminder for an event it cannot read', async () => {
    await handle({ discord_user_id: PERSON, subject: 'event', subject_id: 999, wanted: true });
    expect(await feed.listReminders(PERSON)).toEqual([]);
  });

  it('does nothing about an instruction naming no person', async () => {
    await expect(handle({ subject: 'rso', subject_id: 4, wanted: true }))
      .resolves.toBeUndefined();
  });

  it('does nothing about a subject it does not know', async () => {
    await expect(handle({
      discord_user_id: PERSON, subject: 'the weather', subject_id: 4, wanted: true,
    })).resolves.toBeUndefined();
  });

  /**
   * After applying it, the bot says what it now holds, so that the website's
   * mirror agrees with the record even where the two were changed at once.
   */
  it('reports what it holds afterwards, so the website agrees', async () => {
    await handle({ discord_user_id: PERSON, subject: 'rso', subject_id: 4, wanted: true });
    expect(via.reportedOptIns.at(-1)).toEqual({
      discordUserId: PERSON, following: [4], reminders: [],
    });
  });
});

describe('telling the website what a person follows', () => {
  const PERSON = '204255221017214977';

  it('reports the organizations and the events together', async () => {
    const feed = memoryFeedStore();
    const via = createFakeViaClient();
    await feed.follow(PERSON, 4);
    await feed.follow(PERSON, 9);
    await feed.addReminder(PERSON, 12, '2026-09-21 16:00:00');

    await createOptInReporter({ feed, via }).report(PERSON);

    expect(via.reportedOptIns).toEqual([
      { discordUserId: PERSON, following: [4, 9], reminders: [12] },
    ]);
  });

  /**
   * The web platform being away is not a reason for the command that triggered
   * this to fail in front of the person running it. What they chose is already
   * recorded here, which is what makes it happen.
   */
  it('does not fail the caller when the web platform will not take the report', async () => {
    const feed = memoryFeedStore();
    const via = createFakeViaClient();
    via.failNextWith(new Error('VIA did not answer.'));

    await expect(createOptInReporter({ feed, via }).report(PERSON))
      .resolves.toBeUndefined();
  });
});
