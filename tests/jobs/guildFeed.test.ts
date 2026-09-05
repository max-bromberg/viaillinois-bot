import { describe, it, expect, beforeEach } from 'vitest';
import { createGuildDigestJob, guildDigestPurpose } from '../../src/jobs/guildDigest.ts';
import { createDayOfReminderJob, dayOfPurpose } from '../../src/jobs/dayOfReminders.ts';
import { createThisWeekMessage, THISWEEK_PURPOSE } from '../../src/announce/thisWeek.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { channelTarget } from '../../src/delivery/deliveries.ts';
import { POST_SPREAD_MS } from '../../src/delivery/spread.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { memoryGuildStore } from '../commands/support.ts';
import { memoryDeliveries, recordingActions, recordingDirectMessages } from '../support/proactive.ts';
import type { GuildStore } from '../../src/guilds/store.ts';
import type { JobHour } from '../../src/jobs/scheduler.ts';

/**
 * The three timed posts a server can ask for: the weekly digest, the day of
 * reminders, and the living this week message.
 *
 * All three follow the same rules as the announcements. Nothing is posted in a
 * server that has not switched the feature on. Everything goes through
 * Deliveries first, so an hour run twice posts once. And a server that unbound
 * the channel or took the permission away has the feature switched off with
 * its manager told once, rather than the bot failing quietly every hour for
 * the rest of the term.
 */

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const THIRD_GUILD = '900000000000000003';
const MANAGER = '204255221017214977';
const CHANNEL = '700000000000000001';

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
    rsoId: 1,
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
    rsoId: 1,
    rsoName: 'IEEE',
    title: 'Tutoring',
    startTime: '2026-09-09T16:00:00-05:00',
    endTime: '2026-09-09T18:00:00-05:00',
    building: 'ECEB',
    roomNumber: '3002',
    locationNote: null,
  });
}

function built() {
  const guilds = memoryGuildStore();
  const deliveries = memoryDeliveries();
  const actions = recordingActions({ permissions: ['ViewChannel', 'SendMessages', 'ManageMessages'] });
  const directMessages = recordingDirectMessages();
  const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage: directMessages.send });
  const via = createFakeViaClient();
  seedWeek(via);
  /** The pauses the jobs took between servers, recorded rather than served. */
  const spreads: number[] = [];
  const sleep = async (milliseconds: number) => { spreads.push(milliseconds); };

  return {
    guilds, deliveries, actions, directMessages, disable, via, spreads,
    digest: createGuildDigestJob({ guilds, deliveries, actions, via, disable, sleep }),
    dayOf: createDayOfReminderJob({
      guilds, deliveries, actions, via, disable, sleep, websiteUrl: 'https://viaillinois.com',
    }),
    thisWeek: createThisWeekMessage({ guilds, deliveries, actions, via, disable, sleep }),
  };
}

async function setUp(
  guilds: GuildStore,
  featureId: string,
  options: { channel?: boolean; guildId?: string } = {},
) {
  const guildId = options.guildId ?? GUILD;
  await guilds.createInstallation(guildId, MANAGER);
  await guilds.setKind(guildId, 'rso');
  await guilds.setBinding(guildId, { binding: 'rso', rsoId: 1 });
  await guilds.setFeatureEnabled(guildId, featureId, true);
  if (options.channel !== false) {
    const purpose = featureId === 'announce.digest' ? 'digest'
      : featureId === 'announce.dayof' ? 'reminders' : 'thisweek';
    // Channel identifiers are unique across Discord, so two servers never
    // share one, which is what the delivery key over the target relies on.
    await guilds.bindChannel(guildId, purpose, `7${guildId.slice(1)}`);
  }
}

describe('the weekly digest a server posts', () => {
  // Six in the evening on the campus clock, on Sunday the sixth of September.
  const SUNDAY_EVENING = hourOf('2026-09-06T23:00:00Z');

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  it('posts the coming week, grouped by day, in the channel bound to the digest', async () => {
    await setUp(stack.guilds, 'announce.digest');
    const result = await stack.digest.run(SUNDAY_EVENING);

    expect(result.posted).toBe(1);
    const posts = stack.actions.done.filter(one => one.action === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channelId).toBe(CHANNEL);
    expect(posts[0]!.reply!.content).toContain('Mon, Sep 7');
    expect(posts[0]!.reply!.content).toContain('General meeting');
  });

  /**
   * Section 9 of the design: the proactive jobs spread their posts rather than
   * firing every server's digest in the same second.
   */
  it('pauses between one server and the next, and not before the first', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await setUp(stack.guilds, 'announce.digest', { guildId: OTHER_GUILD });
    await setUp(stack.guilds, 'announce.digest', { guildId: THIRD_GUILD });

    await stack.digest.run(SUNDAY_EVENING);
    expect(stack.spreads).toEqual([POST_SPREAD_MS, POST_SPREAD_MS]);
  });

  it('posts nothing in a server that has not switched the digest on', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await stack.guilds.setFeatureEnabled(GUILD, 'announce.digest', false);

    await stack.digest.run(SUNDAY_EVENING);
    expect(stack.actions.done).toEqual([]);
  });

  it('posts nothing in an hour the server did not choose', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await stack.digest.run(hourOf('2026-09-06T14:00:00Z'));
    expect(stack.actions.done).toEqual([]);
  });

  it('posts nothing in a server that has never been set up', async () => {
    await stack.guilds.createInstallation(GUILD, MANAGER);
    await stack.guilds.setFeatureEnabled(GUILD, 'announce.digest', true);
    await stack.guilds.bindChannel(GUILD, 'digest', CHANNEL);

    await stack.digest.run(SUNDAY_EVENING);
    expect(stack.actions.done).toEqual([]);
  });

  it('switches the digest off and tells the manager when no channel is bound', async () => {
    await setUp(stack.guilds, 'announce.digest', { channel: false });
    await stack.digest.run(SUNDAY_EVENING);

    expect(await stack.guilds.isFeatureEnabled(GUILD, 'announce.digest')).toBe(false);
    expect(stack.directMessages.sent).toHaveLength(1);
    expect(stack.directMessages.sent[0]!.content).toContain('the weekly digest');
  });

  it('posts one digest a week however many times the hour is run', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await stack.digest.run(SUNDAY_EVENING);
    await stack.digest.run(SUNDAY_EVENING);

    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(1);
    expect(stack.deliveries.rows()).toHaveLength(1);
    expect(stack.deliveries.rows()[0]!.purpose).toBe(guildDigestPurpose('2026-09-06'));
    expect(stack.deliveries.rows()[0]!.target).toBe(channelTarget(CHANNEL));
  });

  it('leaves the digest unpinned unless the server asked for it', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await stack.digest.run(SUNDAY_EVENING);
    expect(stack.actions.done.filter(one => one.action === 'pin')).toEqual([]);
  });

  it('pins the digest and unpins the one before it when the server asked for it', async () => {
    await setUp(stack.guilds, 'announce.digest');
    await stack.guilds.setDigestPinned(GUILD, true);

    await stack.digest.run(SUNDAY_EVENING);
    const firstPin = stack.actions.done.find(one => one.action === 'pin')!;
    expect(firstPin.channelId).toBe(CHANNEL);

    await stack.digest.run(hourOf('2026-09-13T23:00:00Z'));
    const unpinned = stack.actions.done.filter(one => one.action === 'unpin');
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.messageId).toBe(firstPin.messageId);
  });

  it('switches the digest off when the channel is no longer one the bot can post in', async () => {
    await setUp(stack.guilds, 'announce.digest');
    stack.actions.failNextWith(Object.assign(new Error('Missing Access'), { code: 50001 }));

    await stack.digest.run(SUNDAY_EVENING);
    expect(await stack.guilds.isFeatureEnabled(GUILD, 'announce.digest')).toBe(false);
    expect(stack.directMessages.sent).toHaveLength(1);
  });
});

describe('the day of reminders a server posts', () => {
  // Five in the evening on campus, an hour before the meeting.
  const AN_HOUR_BEFORE = hourOf('2026-09-07T22:05:00Z');

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  it('posts a reminder for an event whose lead time has passed, with a link to the card', async () => {
    await setUp(stack.guilds, 'announce.dayof');
    const result = await stack.dayOf.run(AN_HOUR_BEFORE);

    expect(result.posted).toBe(1);
    const post = stack.actions.done.find(one => one.action === 'post')!;
    expect(post.channelId).toBe(CHANNEL);
    expect(post.reply!.content).toContain('General meeting');
    expect(post.reply!.components![0]!.components[0]).toMatchObject({
      url: 'https://viaillinois.com/events/10',
    });
  });

  it('posts nothing before the lead time has come', async () => {
    await setUp(stack.guilds, 'announce.dayof');
    const result = await stack.dayOf.run(hourOf('2026-09-07T14:00:00Z'));
    expect(result.posted).toBe(0);
    expect(stack.actions.done).toEqual([]);
  });

  it('posts nothing for an event that has already begun', async () => {
    await setUp(stack.guilds, 'announce.dayof');
    await stack.dayOf.run(hourOf('2026-09-07T23:30:00Z'));
    expect(stack.actions.done).toEqual([]);
  });

  it('honours the lead time the server chose', async () => {
    await setUp(stack.guilds, 'announce.dayof');
    await stack.guilds.setReminderLeadMinutes(GUILD, 240);

    await stack.dayOf.run(hourOf('2026-09-07T19:30:00Z'));
    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(1);
  });

  it('posts one reminder per event however many times it runs', async () => {
    await setUp(stack.guilds, 'announce.dayof');
    await stack.dayOf.run(AN_HOUR_BEFORE);
    await stack.dayOf.run(hourOf('2026-09-07T22:40:00Z'));

    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(1);
    expect(stack.deliveries.rows()[0]!.purpose).toBe(dayOfPurpose(10));
  });

  it('switches the reminders off and tells the manager when no channel is bound', async () => {
    await setUp(stack.guilds, 'announce.dayof', { channel: false });
    await stack.dayOf.run(AN_HOUR_BEFORE);

    expect(await stack.guilds.isFeatureEnabled(GUILD, 'announce.dayof')).toBe(false);
    expect(stack.directMessages.sent[0]!.content).toContain('reminders');
  });
});

describe('the living this week message', () => {
  const MONDAY = new Date('2026-09-07T14:00:00Z');

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  it('posts the week once, pins it, and writes down where it is', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.thisWeek.refreshAll(MONDAY);

    const posts = stack.actions.done.filter(one => one.action === 'post');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.reply!.content).toContain('This week');
    expect(posts[0]!.reply!.content).toContain('General meeting');
    expect(stack.actions.done.filter(one => one.action === 'pin')).toHaveLength(1);

    const held = await stack.guilds.getGuildMessage(GUILD, 'thisweek');
    expect(held).toMatchObject({ channelId: CHANNEL });
    expect(stack.deliveries.rows()[0]!.purpose).toBe(THISWEEK_PURPOSE);
  });

  it('edits the message in place rather than posting a second one', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.thisWeek.refreshAll(MONDAY);
    await stack.thisWeek.refreshAll(new Date('2026-09-07T15:00:00Z'));

    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(1);
    expect(stack.actions.done.filter(one => one.action === 'edit')).toHaveLength(1);
  });

  it('posts a new message when the one it was keeping was deleted', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.thisWeek.refreshAll(MONDAY);

    stack.actions.failNextWith(Object.assign(new Error('Unknown Message'), { code: 10008 }));
    await stack.thisWeek.refreshAll(new Date('2026-09-07T15:00:00Z'));

    expect(stack.actions.done.filter(one => one.action === 'post')).toHaveLength(2);
  });

  it('switches the feature off and tells the manager when the channel is gone', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    stack.actions.failNextWith(Object.assign(new Error('Missing Access'), { code: 50001 }));

    await stack.thisWeek.refreshAll(MONDAY);
    expect(await stack.guilds.isFeatureEnabled(GUILD, 'living.thisweek')).toBe(false);
    expect(stack.directMessages.sent).toHaveLength(1);
  });

  it('posts nothing in a server that has not switched it on', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.guilds.setFeatureEnabled(GUILD, 'living.thisweek', false);

    await stack.thisWeek.refreshAll(MONDAY);
    expect(stack.actions.done).toEqual([]);
  });

  /**
   * The message is brought up to date by the hourly job and by the outbox
   * handlers, so that a meeting moved at nine in the morning is right in the
   * channel at one minute past.
   */
  it('brings the message up to date in every server that follows the organization', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.thisWeek.refreshAll(MONDAY);

    await stack.thisWeek.refreshFollowing(1, new Date('2026-09-07T15:00:00Z'));
    expect(stack.actions.done.filter(one => one.action === 'edit')).toHaveLength(1);
  });

  it('leaves a server that follows another organization alone', async () => {
    await setUp(stack.guilds, 'living.thisweek');
    await stack.thisWeek.refreshAll(MONDAY);

    await stack.thisWeek.refreshFollowing(99, new Date('2026-09-07T15:00:00Z'));
    expect(stack.actions.done.filter(one => one.action === 'edit')).toEqual([]);
  });
});
