import { describe, it, expect, beforeEach } from 'vitest';
import { createExamReminderJob, examReminderPurpose } from '../../src/jobs/examReminders.ts';
import { createGuildExamsJob, guildExamsPurpose, EXAMS_FEATURE } from '../../src/jobs/guildExams.ts';
import { EXAM_STOP_SENTENCE, NO_EXAMS_THIS_WEEK } from '../../src/render/campus.ts';
import { channelTarget, userTarget } from '../../src/delivery/deliveries.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { memoryFeedStore } from '../support/feed.ts';
import { memoryGuildStore } from '../commands/support.ts';
import {
  memoryDeliveries, recordingActions, recordingDelivery, recordingDirectMessages,
} from '../support/proactive.ts';
import type { GuildStore } from '../../src/guilds/store.ts';
import type { JobHour } from '../../src/jobs/scheduler.ts';

/**
 * The exam reminders a person receives and the exams a server posts.
 *
 * The reminder is a direct message, so it obeys the two rules the design sets
 * for those: it goes through Deliveries first, keyed by the person and the
 * exam, so a job that runs twice writes once, and it ends with the way to stop
 * that kind of message. The server message obeys the rules every proactive
 * post obeys: nothing is posted in a server that has not switched the feature
 * on, and a server whose channel has gone has the feature switched off with
 * its manager told once.
 */

const ADA = '204255221017214977';
const GRACE = '204255221017214978';
const GUILD = '900000000000000001';
const MANAGER = '204255221017214977';
const CHANNEL = '700000000000000001';

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

/** One exam on the evening of Thursday the tenth of September. */
function seedExam(via: FakeViaClient, overrides: Record<string, unknown> = {}): void {
  via.seedMidterm({
    midtermId: 20,
    courseCode: 'ECE 385',
    courseTitle: 'Digital Systems Laboratory',
    title: 'Midterm 1',
    startTime: '2026-09-10T19:00:00-05:00',
    endTime: '2026-09-10T21:00:00-05:00',
    status: 'confirmed',
    building: 'Everitt Laboratory',
    roomNumber: '151',
    ...overrides,
  });
}

describe('the exam reminders a person receives', () => {
  function built() {
    const feed = memoryFeedStore();
    const deliveries = memoryDeliveries();
    const delivery = recordingDelivery();
    const via = createFakeViaClient();
    via.clearMidterms();
    return {
      feed, deliveries, delivery, via,
      job: createExamReminderJob({ feed, deliveries, via, deliver: delivery.deliver }),
    };
  }

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  /** An hour before the exam, which is the default lead time. */
  const AN_HOUR_BEFORE = hourOf('2026-09-10T23:00:00Z');
  /** The morning of the exam, which is well before an hour ahead of it. */
  const THAT_MORNING = hourOf('2026-09-10T14:00:00Z');

  it('writes to everybody who added the course, at their own lead time', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.feed.addCourse(GRACE, 'ECE 385');

    const result = await stack.job.run(AN_HOUR_BEFORE);

    expect(result.sent).toBe(2);
    expect(stack.delivery.sent.map(one => one.discordUserId).sort()).toEqual([ADA, GRACE].sort());
    expect(stack.delivery.sent[0]!.reply.content).toContain('ECE 385');
    expect(stack.delivery.sent[0]!.reply.content).toContain('Everitt Laboratory 151');
  });

  it('ends every reminder with the sentence that stops them', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.job.run(AN_HOUR_BEFORE);
    expect(stack.delivery.sent[0]!.reply.content!.endsWith(EXAM_STOP_SENTENCE)).toBe(true);
  });

  it('waits until the lead time before writing', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    const result = await stack.job.run(THAT_MORNING);
    expect(result.sent).toBe(0);
    expect(stack.delivery.sent).toEqual([]);
  });

  it('writes at the lead time the person chose, however far ahead it is', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.feed.savePreferences(ADA, { reminderLeadMinutes: 1440 });

    expect((await stack.job.run(THAT_MORNING)).sent).toBe(1);
  });

  it('writes about one exam once, however many times the job runs', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');

    await stack.job.run(AN_HOUR_BEFORE);
    const second = await stack.job.run(AN_HOUR_BEFORE);

    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(stack.delivery.sent).toHaveLength(1);
    expect(await stack.deliveries.find({
      outboxId: 0,
      target: userTarget(ADA),
      purpose: examReminderPurpose(20),
    })).toMatchObject({ kind: 'direct_message' });
  });

  it('says nothing about an exam whose time nobody has confirmed', async () => {
    seedExam(stack.via, { status: 'pending' });
    await stack.feed.addCourse(ADA, 'ECE 385');
    expect((await stack.job.run(AN_HOUR_BEFORE)).sent).toBe(0);
  });

  it('says nothing about an exam that has already begun', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    expect((await stack.job.run(hourOf('2026-09-11T01:00:00Z'))).sent).toBe(0);
  });

  it('says nothing about a course nobody added', async () => {
    seedExam(stack.via);
    expect((await stack.job.run(AN_HOUR_BEFORE)).sent).toBe(0);
  });

  it('leaves alone a person who turned their direct messages off', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.feed.savePreferences(ADA, { directMessageOptOut: true });

    expect((await stack.job.run(AN_HOUR_BEFORE)).sent).toBe(0);
    expect(stack.delivery.sent).toEqual([]);
  });

  it('turns the direct messages off for somebody who does not accept them', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    stack.delivery.block(ADA);

    const result = await stack.job.run(AN_HOUR_BEFORE);
    expect(result.blocked).toBe(1);
    expect((await stack.feed.preferences(ADA)).directMessageOptOut).toBe(true);
  });

  it('leaves a reminder owed when Discord would not take it', async () => {
    seedExam(stack.via);
    await stack.feed.addCourse(ADA, 'ECE 385');
    stack.delivery.failNext();

    const result = await stack.job.run(AN_HOUR_BEFORE);
    expect(result.failed).toBe(1);
    expect(await stack.deliveries.pending()).toHaveLength(1);
  });
});

describe('the exams a server posts', () => {
  function built() {
    const guilds = memoryGuildStore();
    const deliveries = memoryDeliveries();
    const actions = recordingActions({ permissions: ['ViewChannel', 'SendMessages'] });
    const directMessages = recordingDirectMessages();
    const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage: directMessages.send });
    const via = createFakeViaClient();
    via.clearMidterms();
    return {
      guilds, deliveries, actions, directMessages, disable, via,
      job: createGuildExamsJob({ guilds, deliveries, actions, via, disable }),
    };
  }

  async function setUp(guilds: GuildStore, options: { channel?: boolean; enabled?: boolean } = {}) {
    await guilds.createInstallation(GUILD, MANAGER);
    await guilds.setKind(GUILD, 'community');
    await guilds.setBinding(GUILD, { binding: 'all' });
    await guilds.setFeatureEnabled(GUILD, EXAMS_FEATURE, options.enabled !== false);
    if (options.channel !== false) await guilds.bindChannel(GUILD, 'exams', CHANNEL);
  }

  /** Six in the evening on the campus clock, on Sunday the sixth of September. */
  const SUNDAY_EVENING = hourOf('2026-09-06T23:00:00Z');

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  it('posts the exams of the coming week, grouped by day, in the channel bound to them', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds);

    const result = await stack.job.run(SUNDAY_EVENING);

    expect(result.posted).toBe(1);
    const posts = stack.actions.done.filter(one => one.action === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(CHANNEL);
    expect(posts[0]!.reply!.content).toContain('Thu, Sep 10');
    expect(posts[0]!.reply!.content).toContain('ECE 385');
  });

  it('posts on the day and at the hour the server chose for its digest', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds);
    await stack.guilds.setDigestSchedule(GUILD, 3, 9);

    expect((await stack.job.run(SUNDAY_EVENING)).posted).toBe(0);
    // Nine in the morning on the campus clock, on Wednesday the ninth.
    expect((await stack.job.run(hourOf('2026-09-09T14:00:00Z'))).posted).toBe(1);
  });

  it('leaves an exam beyond the coming week for the week it falls in', async () => {
    seedExam(stack.via, { startTime: '2026-09-20T19:00:00-05:00', endTime: '2026-09-20T21:00:00-05:00' });
    await setUp(stack.guilds);

    await stack.job.run(SUNDAY_EVENING);
    const posts = stack.actions.done.filter(one => one.action === 'post');
    expect(posts[0]!.reply!.content).toContain(NO_EXAMS_THIS_WEEK);
  });

  it('says nothing about an exam whose time nobody has confirmed', async () => {
    seedExam(stack.via, { status: 'pending' });
    await setUp(stack.guilds);

    await stack.job.run(SUNDAY_EVENING);
    const posts = stack.actions.done.filter(one => one.action === 'post');
    expect(posts[0]!.reply!.content).toContain(NO_EXAMS_THIS_WEEK);
  });

  it('posts one week once, however many times the hour is run', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds);

    await stack.job.run(SUNDAY_EVENING);
    const second = await stack.job.run(SUNDAY_EVENING);

    expect(second.posted).toBe(0);
    expect(second.skipped).toBe(1);
    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(1);
    expect(await stack.deliveries.find({
      outboxId: 0,
      target: channelTarget(CHANNEL),
      purpose: guildExamsPurpose(SUNDAY_EVENING.day),
    })).toBeTruthy();
  });

  it('posts nothing in a server that has not switched the feature on', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds, { enabled: false });
    expect((await stack.job.run(SUNDAY_EVENING)).posted).toBe(0);
    expect(stack.actions.done).toEqual([]);
  });

  it('switches the feature off and tells the manager when no channel is bound', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds, { channel: false });

    expect((await stack.job.run(SUNDAY_EVENING)).posted).toBe(0);
    expect(await stack.guilds.isFeatureEnabled(GUILD, EXAMS_FEATURE)).toBe(false);
    expect(stack.directMessages.sent).toHaveLength(1);
    expect(stack.directMessages.sent[0]!.content).toContain('exam notices');
  });

  it('switches the feature off when the channel has gone', async () => {
    seedExam(stack.via);
    await setUp(stack.guilds);
    stack.actions.failNextWith(Object.assign(new Error('Missing Access'), { code: 50001 }));

    expect((await stack.job.run(SUNDAY_EVENING)).posted).toBe(0);
    expect(await stack.guilds.isFeatureEnabled(GUILD, EXAMS_FEATURE)).toBe(false);
  });
});
