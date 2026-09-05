import { describe, it, expect, beforeEach } from 'vitest';
import { createPersonalDigestJob, personalDigestPurpose } from '../../src/jobs/personalDigest.ts';
import { createPersonalReminderJob, reminderPurpose } from '../../src/jobs/personalReminders.ts';
import { DIGEST_STOP_SENTENCE, REMINDER_STOP_SENTENCE } from '../../src/render/digest.ts';
import { userTarget } from '../../src/delivery/deliveries.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { memoryFeedStore } from '../support/feed.ts';
import { memoryDeliveries, recordingDelivery } from '../support/proactive.ts';
import type { JobHour } from '../../src/jobs/scheduler.ts';

/**
 * The personal digest and the personal reminders.
 *
 * Both are direct messages, so both obey the two rules the design sets for
 * them. Every message goes through Deliveries first, keyed by the person and
 * the week or the event, so a job that runs twice writes once. And every
 * message ends with the way to stop that kind of message, which is what makes
 * it acceptable for the bot to write to somebody at all.
 *
 * A person who has closed their direct messages is not a failure to retry. The
 * bot switches their direct messages off, which is the honest state, and it
 * writes to them again only once they turn them back on.
 */

const ADA = '204255221017214977';
const GRACE = '204255221017214978';

/** The campus hour a job is running for, as the scheduler hands it over. */
function hourOf(iso: string): JobHour {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const field = (type: string) => parts.find(part => part.type === type)!.value;
  const day = `${field('year')}-${field('month')}-${field('day')}`;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    at,
    startedAt: `${day} ${field('hour')}:00:00`,
    day,
    hour: Number(field('hour')) % 24,
    dayOfWeek: weekdays[field('weekday')]!,
  };
}

function seedWeek(via: FakeViaClient): void {
  via.clearEvents();
  via.seedEvent({
    eventId: 10,
    rsoId: 3,
    rsoName: 'IEEE',
    title: 'General meeting',
    startTime: '2026-09-07T18:00:00-05:00',
    endTime: '2026-09-07T19:00:00-05:00',
    building: 'ECEB',
    roomNumber: '1002',
    locationNote: null,
  });
  via.seedEvent({
    eventId: 11,
    rsoId: 7,
    rsoName: 'HKN',
    title: 'Tutoring',
    startTime: '2026-09-09T16:00:00-05:00',
    endTime: '2026-09-09T18:00:00-05:00',
    building: 'ECEB',
    roomNumber: '3002',
    locationNote: null,
  });
}

describe('the personal digest', () => {
  // Six in the evening on the campus clock, on Sunday the sixth of September.
  const SUNDAY_EVENING = hourOf('2026-09-06T23:00:00Z');

  let feed: ReturnType<typeof memoryFeedStore>;
  let deliveries: ReturnType<typeof memoryDeliveries>;
  let delivery: ReturnType<typeof recordingDelivery>;
  let via: FakeViaClient;

  function built() {
    return createPersonalDigestJob({ feed, deliveries, via, deliver: delivery.deliver });
  }

  beforeEach(async () => {
    feed = memoryFeedStore();
    deliveries = memoryDeliveries();
    delivery = recordingDelivery();
    via = createFakeViaClient();
    seedWeek(via);
    via.seedLink(ADA);
    via.seedLink(GRACE);
  });

  it('sends the coming week to somebody whose day and hour this is', async () => {
    await feed.follow(ADA, 3);
    const result = await built().run(SUNDAY_EVENING);

    expect(result.sent).toBe(1);
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0]!.discordUserId).toBe(ADA);
    expect(delivery.sent[0]!.reply.content).toContain('General meeting');
    expect(delivery.sent[0]!.reply.content).toContain('Mon, Sep 7');
  });

  it('ends every digest with the way to stop it', async () => {
    await feed.follow(ADA, 3);
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent[0]!.reply.content.endsWith(DIGEST_STOP_SENTENCE)).toBe(true);
  });

  it('leaves out the organizations a person does not follow', async () => {
    await feed.follow(ADA, 3);
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent[0]!.reply.content).not.toContain('Tutoring');
  });

  it('sends everything to somebody who follows every organization', async () => {
    await feed.setFollowAll(ADA, true);
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent[0]!.reply.content).toContain('General meeting');
    expect(delivery.sent[0]!.reply.content).toContain('Tutoring');
  });

  it('writes to nobody in an hour nobody chose', async () => {
    await feed.follow(ADA, 3);
    const result = await built().run(hourOf('2026-09-06T14:00:00Z'));
    expect(result.sent).toBe(0);
    expect(delivery.sent).toEqual([]);
  });

  it('passes over somebody who follows nothing', async () => {
    await feed.savePreferences(GRACE, { digestDay: 0, digestHour: 18 });
    const result = await built().run(SUNDAY_EVENING);
    expect(result.skipped).toBe(1);
    expect(delivery.sent).toEqual([]);
  });

  it('sends one digest a week however many times the hour is run', async () => {
    await feed.follow(ADA, 3);
    await built().run(SUNDAY_EVENING);
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent).toHaveLength(1);
  });

  it('writes down the delivery against the person and the week', async () => {
    await feed.follow(ADA, 3);
    await built().run(SUNDAY_EVENING);

    const rows = deliveries.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe(userTarget(ADA));
    expect(rows[0]!.purpose).toBe(personalDigestPurpose('2026-09-06'));
    expect(rows[0]!.kind).toBe('direct_message');
    expect(rows[0]!.deliveredAt).not.toBe(null);
  });

  it('writes to nobody who has turned direct messages off', async () => {
    await feed.follow(ADA, 3);
    await feed.savePreferences(ADA, { directMessageOptOut: true });
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent).toEqual([]);
  });

  /**
   * Section 6.4 of the design: a person who has closed their direct messages
   * has answered, so the bot switches them off rather than writing every week
   * and failing every week.
   */
  it('switches direct messages off for somebody who does not accept them', async () => {
    await feed.follow(ADA, 3);
    delivery.block(ADA);

    const result = await built().run(SUNDAY_EVENING);
    expect(result.blocked).toBe(1);
    expect((await feed.preferences(ADA)).directMessageOptOut).toBe(true);
  });

  it('does not try again until the person turns their direct messages back on', async () => {
    await feed.follow(ADA, 3);
    delivery.block(ADA);
    await built().run(SUNDAY_EVENING);

    // The next week comes round, and the bot still leaves them alone.
    await built().run(hourOf('2026-09-13T23:00:00Z'));
    expect(delivery.sent).toEqual([]);
  });

  it('leaves a digest that failed to send owed rather than recorded', async () => {
    await feed.follow(ADA, 3);
    delivery.failNext();

    const result = await built().run(SUNDAY_EVENING);
    expect(result.failed).toBe(1);
    expect((await deliveries.pending()).map(row => row.purpose))
      .toEqual([personalDigestPurpose('2026-09-06')]);
  });

  it('carries on to the next person when one of them fails', async () => {
    await feed.follow(ADA, 3);
    await feed.follow(GRACE, 3);
    delivery.failNext();

    const result = await built().run(SUNDAY_EVENING);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  /**
   * A delivery row that was written and never posted says the message is
   * still owed, so the next pass over the same hour sends it. A row that
   * carries the moment it was posted is the one that says there is nothing
   * left to do.
   */
  /**
   * Section 10 of the design: the bot writes only to linked people. A row
   * left behind by a link that went away without the bot hearing about it
   * would otherwise become a message nobody asked for.
   */
  it('writes to nobody the web platform no longer knows', async () => {
    await feed.follow(ADA, 3);
    via.removeLink(ADA);

    const result = await built().run(SUNDAY_EVENING);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(delivery.sent).toEqual([]);
  });

  it('sends a digest that was owed when the hour is run again', async () => {
    await feed.follow(ADA, 3);
    delivery.failNext();
    await built().run(SUNDAY_EVENING);
    expect(delivery.sent).toEqual([]);

    const result = await built().run(SUNDAY_EVENING);
    expect(result.sent).toBe(1);
    expect(delivery.sent).toHaveLength(1);
    expect(await deliveries.pending()).toEqual([]);
  });
});

describe('the personal reminders', () => {
  // Five in the evening on the campus clock, an hour before the meeting.
  const AN_HOUR_BEFORE = hourOf('2026-09-07T22:05:00Z');

  let feed: ReturnType<typeof memoryFeedStore>;
  let deliveries: ReturnType<typeof memoryDeliveries>;
  let delivery: ReturnType<typeof recordingDelivery>;
  let via: FakeViaClient;

  function built() {
    return createPersonalReminderJob({ feed, deliveries, via, deliver: delivery.deliver });
  }

  beforeEach(() => {
    feed = memoryFeedStore();
    deliveries = memoryDeliveries();
    delivery = recordingDelivery();
    via = createFakeViaClient();
    seedWeek(via);
    via.seedLink(ADA);
    via.seedLink(GRACE);
  });

  it('sends a reminder that has come due, naming the event and where it is', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    const result = await built().run(AN_HOUR_BEFORE);

    expect(result.sent).toBe(1);
    expect(delivery.sent[0]!.discordUserId).toBe(ADA);
    expect(delivery.sent[0]!.reply.content).toContain('General meeting');
    expect(delivery.sent[0]!.reply.content).toContain('ECEB 1002');
  });

  it('ends every reminder with the way to stop it', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    await built().run(AN_HOUR_BEFORE);
    expect(delivery.sent[0]!.reply.content.endsWith(REMINDER_STOP_SENTENCE)).toBe(true);
  });

  it('forgets a reminder once it has been sent, so it is sent once', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    await built().run(AN_HOUR_BEFORE);
    await built().run(AN_HOUR_BEFORE);

    expect(delivery.sent).toHaveLength(1);
    expect(await feed.listReminders(ADA)).toEqual([]);
  });

  it('writes down the delivery against the person and the event', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    await built().run(AN_HOUR_BEFORE);

    const rows = deliveries.rows();
    expect(rows[0]!.target).toBe(userTarget(ADA));
    expect(rows[0]!.purpose).toBe(reminderPurpose(10));
    expect(rows[0]!.kind).toBe('direct_message');
  });

  /**
   * Whether somebody may see an event is the web platform's decision, so the
   * reminder is read as the person who asked for it rather than as nobody.
   */
  it('reminds a member of a meeting their organization marked internal', async () => {
    via.seedEvent({
      eventId: 12,
      rsoId: 1,
      rsoName: 'IEEE',
      title: 'Board sync',
      isPrivate: true,
      startTime: '2026-09-07T18:00:00-05:00',
      endTime: '2026-09-07T19:00:00-05:00',
      building: 'ECEB',
      roomNumber: '2015',
      locationNote: null,
    });
    via.seedLink(ADA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    await feed.addReminder(ADA, 12, '2026-09-07 17:00:00');

    await built().run(AN_HOUR_BEFORE);
    expect(delivery.sent[0]!.reply.content).toContain('Board sync');
  });

  it('leaves a reminder that is not due yet alone', async () => {
    await feed.addReminder(ADA, 11, '2026-09-09 15:00:00');
    const result = await built().run(AN_HOUR_BEFORE);
    expect(result.sent).toBe(0);
    expect(await feed.listReminders(ADA)).toHaveLength(1);
  });

  it('forgets a reminder for an event VIA no longer has, without writing to anybody', async () => {
    await feed.addReminder(ADA, 99, '2026-09-07 17:00:00');
    const result = await built().run(AN_HOUR_BEFORE);

    expect(delivery.sent).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(await feed.listReminders(ADA)).toEqual([]);
  });

  it('forgets a reminder whose event has already begun, because it is not a reminder any more', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    const result = await built().run(hourOf('2026-09-07T23:30:00Z'));

    expect(delivery.sent).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(await feed.listReminders(ADA)).toEqual([]);
  });

  it('writes to nobody who has turned direct messages off', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    await feed.savePreferences(ADA, { directMessageOptOut: true });

    await built().run(AN_HOUR_BEFORE);
    expect(delivery.sent).toEqual([]);
  });

  it('switches direct messages off for somebody who does not accept them', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    delivery.block(ADA);

    const result = await built().run(AN_HOUR_BEFORE);
    expect(result.blocked).toBe(1);
    expect((await feed.preferences(ADA)).directMessageOptOut).toBe(true);
  });

  it('carries on to the next reminder when one of them fails', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    await feed.addReminder(GRACE, 10, '2026-09-07 17:00:00');
    delivery.failNext();

    const result = await built().run(AN_HOUR_BEFORE);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  /**
   * Section 10 of the design: the bot writes only to linked people. A
   * reminder left behind by a link that went away is forgotten rather than
   * turned into a message nobody asked for.
   */
  it('writes to nobody the web platform no longer knows', async () => {
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');
    via.removeLink(ADA);

    const result = await built().run(AN_HOUR_BEFORE);
    expect(delivery.sent).toEqual([]);
    expect(result.dropped).toBe(1);
    expect(await feed.listReminders(ADA)).toEqual([]);
  });
});
