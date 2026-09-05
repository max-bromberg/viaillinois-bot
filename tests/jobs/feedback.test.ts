import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFeedbackJob, feedbackPurpose, FEEDBACK_FEATURE, FEEDBACK_HOUR,
} from '../../src/jobs/feedback.ts';
import { FEEDBACK_BUTTON, FEEDBACK_STOP_SENTENCE } from '../../src/render/feedback.ts';
import { userTarget } from '../../src/delivery/deliveries.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { memoryFeedStore, memoryInterestMarks } from '../support/feed.ts';
import { memoryDeliveries, recordingDelivery } from '../support/proactive.ts';
import { memoryGuildStore } from '../commands/support.ts';
import type { GuildStore } from '../../src/guilds/store.ts';
import type { JobHour } from '../../src/jobs/scheduler.ts';

/**
 * The feedback request of section 6.4.
 *
 * The morning after an event, the linked people who marked interest in it or
 * asked to be reminded of it receive one direct message with five buttons and
 * a way to stop being asked again. This is the first thing the bot sends that
 * the person did not explicitly ask for, so every rule about it is a rule
 * about not asking: not twice, not after somebody said no, not on behalf of an
 * organization whose server switched feedback off, and not to somebody whose
 * VIA account has gone.
 */

const ADA = '204255221017214977';
const GRACE = '204255221017214978';
const ROSA = '204255221017214979';
const GUILD = '900000000000000001';

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

describe('the feedback request the morning after an event', () => {
  // Nine in the morning on the campus clock, on Tuesday the eighth of
  // September, which is the morning after the seventh.
  const MORNING_AFTER = hourOf('2026-09-08T14:00:00Z');

  let feed: ReturnType<typeof memoryFeedStore>;
  let marks: ReturnType<typeof memoryInterestMarks>;
  let deliveries: ReturnType<typeof memoryDeliveries>;
  let delivery: ReturnType<typeof recordingDelivery>;
  let guilds: GuildStore;
  let via: FakeViaClient;

  function built() {
    return createFeedbackJob({ feed, marks, guilds, deliveries, via, deliver: delivery.deliver });
  }

  /** One event of the seventh, which is the day before the job runs. */
  function seedYesterday(overrides: Record<string, unknown> = {}) {
    return via.seedEvent({
      eventId: 10,
      rsoId: 3,
      rsoName: 'IEEE',
      title: 'General meeting',
      startTime: '2026-09-07T18:00:00-05:00',
      endTime: '2026-09-07T19:00:00-05:00',
      building: 'ECEB',
      roomNumber: '1002',
      ...overrides,
    });
  }

  beforeEach(async () => {
    feed = memoryFeedStore();
    marks = memoryInterestMarks();
    deliveries = memoryDeliveries();
    delivery = recordingDelivery();
    guilds = memoryGuildStore();
    via = createFakeViaClient();
    via.clearEvents();
    via.seedLink(ADA);
    via.seedLink(GRACE);
  });

  it('asks everybody who marked interest in an event that ended yesterday, once each', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await marks.mark(10, GRACE);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(2);
    expect(delivery.sent.map(one => one.discordUserId).sort()).toEqual([ADA, GRACE]);
    const message = delivery.sent[0]!.reply;
    expect(message.content).toContain('General meeting');
    expect(message.content).toContain(FEEDBACK_STOP_SENTENCE);
  });

  /**
   * An event an organization marked internal is described only to somebody
   * who may see it, which is the web platform's decision rather than one made
   * here. So the event is read once for each person about to be asked, and
   * anybody the read comes back empty for is passed over in silence rather
   * than sent a message naming a meeting they cannot see.
   */
  it('never describes an internal event to somebody who cannot see it', async () => {
    via.seedLink(ADA, { memberships: [{ rsoId: 3, rsoName: 'IEEE', role: 'member' }] });
    via.seedLink(GRACE, { memberships: [] });
    seedYesterday({ isPrivate: true });
    await marks.mark(10, ADA);
    await marks.mark(10, GRACE);

    const result = await built().run(MORNING_AFTER);

    expect(delivery.sent.map(one => one.discordUserId)).toEqual([ADA]);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
  });

  /**
   * The message goes to anybody who marked interest or asked to be reminded,
   * which are two different things, and the date it names is the date the
   * event ran rather than the date anybody pressed anything. Saying otherwise
   * tells half the people who receive it something they did not do.
   */
  it('says why it is asking without claiming what the person pressed', async () => {
    seedYesterday();
    await feed.addReminder(ADA, 10, '2026-09-07 17:00:00');

    await built().run(MORNING_AFTER);
    const content = delivery.sent[0]!.reply.content;
    expect(content).toContain('You asked VIA about this event from IEEE, which ran on Mon, Sep 7.');
    expect(content).not.toContain('You marked interest in this event');
  });

  it('carries the five scores and the way to stop being asked', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await built().run(MORNING_AFTER);

    const rows = delivery.sent[0]!.reply.components!;
    const buttons = rows.flatMap(row => row.components);
    expect(buttons.map(one => (one as { customId?: string }).customId)).toEqual([
      FEEDBACK_BUTTON.rate(10, 1),
      FEEDBACK_BUTTON.rate(10, 2),
      FEEDBACK_BUTTON.rate(10, 3),
      FEEDBACK_BUTTON.rate(10, 4),
      FEEDBACK_BUTTON.rate(10, 5),
      FEEDBACK_BUTTON.stop(10),
    ]);
  });

  it('asks the people who asked to be reminded of it as well as the people who marked interest', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await feed.addReminder(GRACE, 10, '2026-09-07 17:00:00');

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(2);
    expect(delivery.sent.map(one => one.discordUserId).sort()).toEqual([ADA, GRACE]);
  });

  it('writes one delivery per person and event, keyed by the event', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await built().run(MORNING_AFTER);

    expect(deliveries.rows()).toHaveLength(1);
    expect(deliveries.rows()[0]).toMatchObject({
      target: userTarget(ADA),
      purpose: feedbackPurpose(10),
      kind: 'direct_message',
    });
  });

  it('asks nobody a second time, however often the job runs', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await built().run(MORNING_AFTER);

    // The marks are cleared once the event has been asked about, so the second
    // run is given the mark again, as pressing Interested again would.
    await marks.mark(10, ADA);
    const second = await built().run(MORNING_AFTER);

    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(delivery.sent).toHaveLength(1);
  });

  it('runs at nine in the morning and at no other hour', async () => {
    seedYesterday();
    await marks.mark(10, ADA);

    const result = await built().run(hourOf('2026-09-08T20:00:00Z'));

    expect(FEEDBACK_HOUR).toBe(9);
    expect(result.sent).toBe(0);
    expect(delivery.sent).toHaveLength(0);
    // Nothing was dealt with, so the mark is still there for the morning.
    expect(await marks.listEvents()).toEqual([10]);
  });

  it('says nothing to somebody who turned feedback messages off', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await feed.savePreferences(ADA, { feedbackOptOut: true });

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(delivery.sent).toHaveLength(0);
  });

  it('says nothing to somebody who turned direct messages off', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await feed.savePreferences(ADA, { directMessageOptOut: true });

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(delivery.sent).toHaveLength(0);
  });

  it('asks nobody about the events of an organization whose server switched feedback off', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await guilds.createInstallation(GUILD, ROSA);
    await guilds.setKind(GUILD, 'rso');
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 3, boundBy: ROSA });
    await guilds.setFeatureEnabled(GUILD, FEEDBACK_FEATURE, false);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(delivery.sent).toHaveLength(0);
    expect(await marks.listEvents()).toEqual([]);
  });

  it('still asks when a server that only follows the organization switched feedback off', async () => {
    // A community server that follows an organization does not speak for it,
    // so its own switch stops nothing outside its own channels.
    seedYesterday();
    await marks.mark(10, ADA);
    await guilds.createInstallation(GUILD, ROSA);
    await guilds.setKind(GUILD, 'community');
    await guilds.setBinding(GUILD, { binding: 'all' });
    await guilds.setFeatureEnabled(GUILD, FEEDBACK_FEATURE, false);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(1);
  });

  it('passes over somebody who unlinked between the event and the morning after', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await marks.mark(10, ROSA);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(1);
    expect(delivery.sent.map(one => one.discordUserId)).toEqual([ADA]);
    expect(result.skipped).toBe(1);
  });

  it('switches direct messages off for somebody who does not accept them', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    delivery.block(ADA);

    const result = await built().run(MORNING_AFTER);

    expect(result.blocked).toBe(1);
    expect((await feed.preferences(ADA)).directMessageOptOut).toBe(true);
  });

  it('leaves an event that has not happened yet alone', async () => {
    via.seedEvent({
      eventId: 11,
      rsoId: 3,
      title: 'Next week',
      startTime: '2026-09-14T18:00:00-05:00',
      endTime: '2026-09-14T19:00:00-05:00',
    });
    await marks.mark(11, ADA);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(delivery.sent).toHaveLength(0);
    expect(await marks.listEvents()).toEqual([11]);
  });

  it('asks nothing about an event that was cancelled, and forgets the marks on it', async () => {
    seedYesterday({ cancelledAt: '2026-09-06T12:00:00-05:00' });
    await marks.mark(10, ADA);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(delivery.sent).toHaveLength(0);
    expect(await marks.listEvents()).toEqual([]);
  });

  it('forgets the marks on an event VIA no longer has', async () => {
    await marks.mark(99, ADA);

    const result = await built().run(MORNING_AFTER);

    expect(result.sent).toBe(0);
    expect(await marks.listEvents()).toEqual([]);
  });

  it('forgets the marks on an event once its feedback has been asked for', async () => {
    seedYesterday();
    await marks.mark(10, ADA);
    await built().run(MORNING_AFTER);
    expect(await marks.listEvents()).toEqual([]);
  });
});
