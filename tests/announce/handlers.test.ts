import { describe, it, expect } from 'vitest';
import { createAnnouncementHandlers } from '../../src/announce/handlers.ts';
import { createScheduledEventMirror } from '../../src/mirror/scheduledEvents.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryGuildStore } from '../commands/support.ts';
import {
  memoryDeliveries, memoryEventMirrors, recordingActions, recordingDirectMessages,
} from '../support/proactive.ts';
import type { RecordedAction } from '../support/proactive.ts';
import type { GuildStore } from '../../src/guilds/store.ts';
import type { OutboxEntry, ViaEvent } from '../../src/via/client.ts';

/**
 * Announcements.
 *
 * The outbox says something happened to an event, and every server that
 * follows the organization it belongs to hears about it in the channel it
 * bound to announcements. The rules from section 6.3 of the design are what
 * these tests are about: a series is announced once rather than once per
 * meeting, a change edits the announcement in place so that it always
 * describes the event as it is now, a move or a cancellation adds a short
 * notice that replies to it, and a deletion leaves an announcement that says
 * the event was removed.
 *
 * Which servers hear about it is the other half. A server bound to the
 * organization, a server that follows all of ECE and a server whose chosen
 * set contains it all hear about it once each. A server that has not switched
 * announcements on hears nothing, and a server that unbound its announcements
 * channel has the feature switched off with one direct message to its manager
 * rather than a failure every few minutes.
 */

const RSO_SERVER = '900000000000000001';
const COMMUNITY_ALL = '900000000000000002';
const COMMUNITY_SET = '900000000000000003';
const OTHER_RSO_SERVER = '900000000000000004';
const MANAGER = '204255221017214977';

/**
 * The channel each server bound to announcements. Channel identifiers are
 * unique across Discord, so two servers never share one, and the delivery key
 * over the entry, the target and the purpose relies on exactly that.
 */
const channelFor = (guildId: string) => `7${guildId.slice(1)}`;
const CHANNEL = channelFor(RSO_SERVER);
const NOW = new Date('2026-09-05T14:30:00Z');

function event(overrides: Partial<ViaEvent> = {}): ViaEvent {
  return {
    eventId: 10,
    rsoId: 1,
    rsoName: 'IEEE',
    title: 'General meeting',
    description: 'Bring a laptop.',
    startTime: '2026-09-10T18:00:00-05:00',
    endTime: '2026-09-10T19:00:00-05:00',
    isPrivate: false,
    cancelledAt: null,
    locationId: 5,
    building: 'Electrical & Computer Eng Bldg',
    roomNumber: '1002',
    locationText: null,
    locationNote: null,
    seriesId: null,
    seriesFrequency: null,
    seriesIntervalWeeks: null,
    seriesDaysOfWeek: null,
    seriesEndsOn: null,
    interestCount: 3,
    ...overrides,
  };
}

/** One server, set up as far as a test needs it to be. */
async function server(guilds: GuildStore, options: {
  guildId: string;
  binding: 'rso' | 'all' | 'set';
  rsoId?: number;
  followed?: number[];
  channel?: string | null;
  announceNew?: boolean;
  announceChanges?: boolean;
  mirror?: boolean;
}) {
  const { guildId } = options;
  await guilds.createInstallation(guildId, MANAGER);
  await guilds.setKind(guildId, options.binding === 'rso' ? 'rso' : 'community');
  await guilds.setBinding(guildId, {
    binding: options.binding,
    ...(options.rsoId === undefined ? {} : { rsoId: options.rsoId }),
  });
  if (options.followed) await guilds.setFollowedRsos(guildId, options.followed);
  if (options.channel !== null) {
    await guilds.bindChannel(guildId, 'announcements', options.channel ?? channelFor(guildId));
  }
  await guilds.setFeatureEnabled(guildId, 'announce.new', options.announceNew !== false);
  await guilds.setFeatureEnabled(guildId, 'announce.changes', options.announceChanges !== false);
  await guilds.setFeatureEnabled(guildId, 'mirror.scheduled', options.mirror === true);
}

/** The living this week message, as a list of the servers it was asked about. */
function recordingThisWeek() {
  const refreshed: string[] = [];
  return {
    refreshed,
    message: {
      async refresh(installation: { guildId: string }) {
        refreshed.push(installation.guildId);
        return true;
      },
      async refreshAll() { return { posted: 0, updated: 0, failed: 0 }; },
      async refreshFollowing() { return { posted: 0, updated: 0, failed: 0 }; },
    },
  };
}

async function built(options: { withMirror?: boolean } = {}) {
  const guilds = memoryGuildStore();
  const mirrors = memoryEventMirrors();
  const deliveries = memoryDeliveries();
  const actions = recordingActions();
  const directMessages = recordingDirectMessages();
  const via = createFakeViaClient();
  const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage: directMessages.send });

  const mirror = createScheduledEventMirror({
    guilds, mirrors, deliveries, actions, via, disable, now: () => NOW,
  });

  const thisWeek = recordingThisWeek();

  const handlers = createAnnouncementHandlers({
    guilds,
    mirrors,
    deliveries,
    actions,
    via,
    disable,
    websiteUrl: 'https://viaillinois.com',
    thisWeek: thisWeek.message,
    ...(options.withMirror === false ? {} : { mirror }),
  });

  return { guilds, mirrors, deliveries, actions, directMessages, via, mirror, handlers, thisWeek };
}

/** An outbox entry of a kind, carrying the event or series a test names. */
function entryOf(kind: string, payload: Record<string, unknown>, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: 1,
    kind,
    subjectType: kind.startsWith('series') ? 'series' : 'event',
    subjectId: '10',
    rsoId: 1,
    payload,
    createdAt: '2026-09-05T12:00:00-05:00',
    ...overrides,
  };
}

/** The event as the web platform writes it into an outbox payload. */
function payloadEvent(overrides: Partial<ViaEvent> = {}): Record<string, unknown> {
  const one = event(overrides);
  return {
    event_id: one.eventId,
    rso_id: one.rsoId,
    rso_name: one.rsoName,
    title: one.title,
    description: one.description,
    start_time: one.startTime,
    end_time: one.endTime,
    is_private: one.isPrivate,
    cancelled_at: one.cancelledAt,
    location_id: one.locationId,
    building: one.building,
    room_number: one.roomNumber,
    location_text: one.locationText,
    location_note: one.locationNote,
    series_id: one.seriesId,
    series_frequency: one.seriesFrequency,
    series_interval_weeks: one.seriesIntervalWeeks,
    series_days_of_week: one.seriesDaysOfWeek,
    series_ends_on: one.seriesEndsOn,
    interest_count: one.interestCount,
  };
}

const posts = (actions: { done: RecordedAction[] }) =>
  actions.done.filter(one => one.action === 'post');
const edits = (actions: { done: RecordedAction[] }) =>
  actions.done.filter(one => one.action === 'edit');

describe('which servers hear about a new event', () => {
  async function everyKindOfServer() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await server(helpers.guilds, { guildId: COMMUNITY_ALL, binding: 'all' });
    await server(helpers.guilds, { guildId: COMMUNITY_SET, binding: 'set', followed: [1, 9] });
    await server(helpers.guilds, { guildId: OTHER_RSO_SERVER, binding: 'rso', rsoId: 9 });
    return helpers;
  }

  it('announces once in the server bound to the organization', async () => {
    const { handlers, actions } = await everyKindOfServer();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));

    const channels = posts(actions).map(one => (one as { channelId?: string }).channelId);
    expect(channels).toHaveLength(3);
  });

  it('announces in the community server that follows all of ECE', async () => {
    const { handlers, mirrors } = await everyKindOfServer();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect((await mirrors.get(COMMUNITY_ALL, 10))!.announcementMessageId).not.toBe(null);
  });

  it('announces in the community server whose chosen set contains the organization', async () => {
    const { handlers, mirrors } = await everyKindOfServer();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect((await mirrors.get(COMMUNITY_SET, 10))!.announcementMessageId).not.toBe(null);
  });

  it('says nothing in a server bound to another organization', async () => {
    const { handlers, mirrors } = await everyKindOfServer();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(await mirrors.get(OTHER_RSO_SERVER, 10)).toBe(null);
  });

  it('says nothing in a server that has not switched announcements on', async () => {
    const { guilds, handlers, actions } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1, announceNew: false });
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(actions.done).toEqual([]);
  });

  it('never announces an event an organization marked internal', async () => {
    const { guilds, handlers, actions } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent({ isPrivate: true }) }));
    expect(actions.done).toEqual([]);
  });

  it('announces once however many times the same entry is handled', async () => {
    const { guilds, handlers, actions } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    const entry = entryOf('event.created', { event: payloadEvent() });
    await handlers['event.created']!(entry);
    await handlers['event.created']!(entry);
    expect(posts(actions)).toHaveLength(1);
  });
});

describe('what a new event announcement says', () => {
  async function announced() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await helpers.handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    return helpers;
  }

  it('posts the card into the channel the server bound to announcements', async () => {
    const { actions } = await announced();
    const [post] = posts(actions);
    expect(post!.channelId).toBe(CHANNEL);
    expect(post!.reply!.content).toContain('General meeting');
    expect(post!.reply!.content).toContain('IEEE');
  });

  it('writes down the message it left behind, so a change can edit it', async () => {
    const { mirrors } = await announced();
    const held = await mirrors.get(RSO_SERVER, 10);
    expect(held!.announcementChannelId).toBe(CHANNEL);
    expect(held!.announcementMessageId).not.toBe(null);
  });

  it('records the delivery against the entry, the channel and the kind', async () => {
    const { deliveries } = await announced();
    const [row] = deliveries.rows();
    expect(row!.outboxId).toBe(1);
    expect(row!.target).toBe(`channel:${CHANNEL}`);
    expect(row!.purpose).toBe('event.created');
    expect(row!.deliveredAt).not.toBe(null);
  });
});

describe('a series, which is announced once', () => {
  async function withSeries() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    helpers.via.clearEvents();
    helpers.via.seedEvent({ eventId: 10, startTime: '2026-09-10T18:00:00-05:00', endTime: '2026-09-10T19:00:00-05:00', seriesId: 4 });
    helpers.via.seedEvent({ eventId: 11, startTime: '2026-09-17T18:00:00-05:00', endTime: '2026-09-17T19:00:00-05:00', seriesId: 4 });
    helpers.via.seedEvent({ eventId: 12, startTime: '2026-09-24T18:00:00-05:00', endTime: '2026-09-24T19:00:00-05:00', seriesId: 4 });
    return helpers;
  }

  const seriesEntry = (kind: string, extra: Record<string, unknown> = {}) => entryOf(kind, {
    series: {
      series_id: 4,
      rso_id: 1,
      frequency: 'weekly',
      interval_weeks: 1,
      days_of_week: 'MO,WE',
      starts_on: '2026-09-07',
      ends_on: '2026-12-09',
      start_of_day: '18:00:00',
      duration_minutes: 60,
    },
    event_ids: [10, 11, 12],
    ...extra,
  }, { subjectId: '4' });

  it('posts one announcement rather than one for each meeting', async () => {
    const { handlers, actions } = await withSeries();
    await handlers['series.created']!(seriesEntry('series.created'));
    expect(posts(actions)).toHaveLength(1);
  });

  it('says the pattern the meetings repeat on and the date they end', async () => {
    const { handlers, actions } = await withSeries();
    await handlers['series.created']!(seriesEntry('series.created'));
    const [post] = posts(actions);
    expect(post!.reply!.content).toContain('every week');
    expect(post!.reply!.content).toContain('Dec 9');
  });

  it('writes the announcement down against the first meeting, so a change can find it', async () => {
    const { handlers, mirrors } = await withSeries();
    await handlers['series.created']!(seriesEntry('series.created'));
    expect((await mirrors.get(RSO_SERVER, 10))!.announcementMessageId).not.toBe(null);
    expect(await mirrors.get(RSO_SERVER, 11)).toBe(null);
  });

  it('edits that one announcement when the series changes', async () => {
    const { handlers, actions } = await withSeries();
    await handlers['series.created']!(seriesEntry('series.created'));
    await handlers['series.updated']!(seriesEntry('series.updated', {
      affected_event_ids: [11, 12],
      changed: ['title'],
    }));

    expect(posts(actions)).toHaveLength(1);
    expect(edits(actions)).toHaveLength(1);
  });

  it('says the meetings were removed when the series is deleted', async () => {
    const { handlers, actions } = await withSeries();
    await handlers['series.created']!(seriesEntry('series.created'));
    await handlers['series.deleted']!(seriesEntry('series.deleted', {
      event_ids: [],
      affected_event_ids: [10, 11, 12],
    }));

    const [edit] = edits(actions);
    expect(edit!.reply!.content.toLowerCase()).toContain('removed');
    expect(edit!.reply!.components ?? []).toEqual([]);
  });

  it('announces nothing for a series whose meetings VIA no longer has', async () => {
    const { handlers, actions, via } = await withSeries();
    via.clearEvents();
    await handlers['series.created']!(seriesEntry('series.created'));
    expect(actions.done).toEqual([]);
  });
});

describe('an event that changed', () => {
  async function announced() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await helpers.handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    return helpers;
  }

  const moved = entryOf('event.updated', {
    event: payloadEvent({ startTime: '2026-09-11T19:00:00-05:00', endTime: '2026-09-11T20:00:00-05:00' }),
    changed: ['start_time', 'end_time'],
  }, { outboxId: 2 });

  it('edits the announcement in place, so it describes the event as it is now', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(moved);

    const [edit] = edits(actions);
    expect(edit!.reply!.content).toContain('7:00 PM');
  });

  it('posts a short notice that replies to the announcement when the event moved', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(moved);

    const notices = posts(actions).slice(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.reply!.content).toContain('moved');
    expect(notices[0]!.replyToMessageId).not.toBeUndefined();
  });

  /**
   * A postponement made from Discord carries a reason, and the web platform
   * puts it in the entry rather than in the event. A channel reading that a
   * meeting has moved wants to know why, so the notice says it.
   */
  it('says why the event moved when the board gave a reason', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(entryOf('event.updated', {
      event: payloadEvent({ startTime: '2026-09-11T19:00:00-05:00', endTime: '2026-09-11T20:00:00-05:00' }),
      changed: ['start_time', 'end_time'],
      reason: 'The room flooded.',
    }, { outboxId: 3 }));

    const notices = posts(actions).slice(1);
    expect(notices[0]!.reply!.content).toContain('The room flooded.');
  });

  it('says only that it moved when the board gave no reason', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(moved);
    const notices = posts(actions).slice(1);
    expect(notices[0]!.reply!.content).not.toContain('The reason given');
  });

  it('edits without a notice when what changed was neither the time nor the place', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(entryOf('event.updated', {
      event: payloadEvent({ description: 'Bring two laptops.' }),
      changed: ['description'],
    }, { outboxId: 2 }));

    expect(edits(actions)).toHaveLength(1);
    expect(posts(actions)).toHaveLength(1);
  });

  it('marks the announcement cancelled and posts a notice when the event is cancelled', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.cancelled']!(entryOf('event.cancelled', {
      event: payloadEvent({ cancelledAt: '2026-09-05T12:00:00-05:00' }),
    }, { outboxId: 3 }));

    const [edit] = edits(actions);
    expect(edit!.reply!.content).toContain('cancelled');
    const notices = posts(actions).slice(1);
    expect(notices[0]!.reply!.content.toLowerCase()).toContain('cancelled');
  });

  it('says the event was removed, and posts no notice, when it is deleted', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.deleted']!(entryOf('event.deleted', { event: payloadEvent() }, { outboxId: 4 }));

    const [edit] = edits(actions);
    expect(edit!.reply!.content.toLowerCase()).toContain('removed');
    expect(posts(actions)).toHaveLength(1);
  });

  it('says nothing at all in a server that never announced the event', async () => {
    const { guilds, handlers, actions } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await handlers['event.updated']!(moved);
    expect(actions.done).toEqual([]);
  });

  it('says nothing in a server that switched change announcements off', async () => {
    const { guilds, handlers, actions } = await announced();
    await guilds.setFeatureEnabled(RSO_SERVER, 'announce.changes', false);
    await handlers['event.updated']!(moved);
    expect(edits(actions)).toEqual([]);
  });

  it('edits and posts the notice once however many times the entry is handled', async () => {
    const { handlers, actions } = await announced();
    await handlers['event.updated']!(moved);
    await handlers['event.updated']!(moved);
    expect(edits(actions)).toHaveLength(1);
    expect(posts(actions)).toHaveLength(2);
  });
});

describe('a server that unbound its announcements channel', () => {
  async function withoutChannel() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1, channel: null });
    return helpers;
  }

  it('posts nothing, because there is nowhere to post', async () => {
    const { handlers, actions } = await withoutChannel();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(actions.done).toEqual([]);
  });

  it('switches the feature off rather than failing on every entry', async () => {
    const { guilds, handlers } = await withoutChannel();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(await guilds.isFeatureEnabled(RSO_SERVER, 'announce.new')).toBe(false);
  });

  it('tells the manager once, with the reason', async () => {
    const { guilds, handlers, directMessages } = await withoutChannel();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    await guilds.setFeatureEnabled(RSO_SERVER, 'announce.new', true);
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }, { outboxId: 2 }));

    expect(directMessages.sent).toHaveLength(1);
    expect(directMessages.sent[0]!.discordUserId).toBe(MANAGER);
    expect(directMessages.sent[0]!.content).toContain('no channel is bound to announcements');
  });
});

describe('keeping the Events tab in step with the outbox', () => {
  async function mirroring() {
    const helpers = await built();
    await server(helpers.guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1, mirror: true });
    return helpers;
  }

  it('creates the scheduled event when the event is created', async () => {
    const { handlers, actions } = await mirroring();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(1);
  });

  it('edits the scheduled event when the event moves', async () => {
    const { handlers, actions } = await mirroring();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    await handlers['event.updated']!(entryOf('event.updated', {
      event: payloadEvent({ startTime: '2026-09-11T19:00:00-05:00', endTime: '2026-09-11T20:00:00-05:00' }),
      changed: ['start_time'],
    }, { outboxId: 2 }));

    expect(actions.done.filter(one => one.action === 'editScheduledEvent')).toHaveLength(1);
  });

  it('deletes the scheduled event when the event is cancelled', async () => {
    const { handlers, actions } = await mirroring();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    await handlers['event.cancelled']!(entryOf('event.cancelled', {
      event: payloadEvent({ cancelledAt: '2026-09-05T12:00:00-05:00' }),
    }, { outboxId: 3 }));

    expect(actions.done.filter(one => one.action === 'deleteScheduledEvent')).toHaveLength(1);
  });

  it('deletes the scheduled event when the event is deleted', async () => {
    const { handlers, actions } = await mirroring();
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    await handlers['event.deleted']!(entryOf('event.deleted', { event: payloadEvent() }, { outboxId: 4 }));
    expect(actions.done.filter(one => one.action === 'deleteScheduledEvent')).toHaveLength(1);
  });

  it('leaves the Events tab alone in a server that has not switched mirroring on', async () => {
    const { guilds, handlers, actions } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1, mirror: false });
    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toEqual([]);
  });

  it('answers every outbox kind the first release handles', async () => {
    const { handlers } = await built();
    expect(Object.keys(handlers).sort()).toEqual([
      'event.cancelled',
      'event.created',
      'event.deleted',
      'event.updated',
      'series.created',
      'series.deleted',
      'series.updated',
    ]);
  });
});

/**
 * The living this week message is brought up to date by the outbox handlers as
 * well as by the hourly job, so that a meeting moved at nine in the morning is
 * right in the channel at one minute past rather than at ten.
 */
describe('keeping the this week message current', () => {
  it('brings it up to date in every server that follows the organization', async () => {
    const { handlers, guilds, thisWeek } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });
    await server(guilds, { guildId: COMMUNITY_ALL, binding: 'all' });

    await handlers['event.updated']!(entryOf('event.updated', { event: payloadEvent(), changed: ['title'] }));
    expect(thisWeek.refreshed.sort()).toEqual([RSO_SERVER, COMMUNITY_ALL].sort());
  });

  it('brings it up to date when an event is created and when one is removed', async () => {
    const { handlers, guilds, thisWeek } = await built();
    await server(guilds, { guildId: RSO_SERVER, binding: 'rso', rsoId: 1 });

    await handlers['event.created']!(entryOf('event.created', { event: payloadEvent() }));
    await handlers['event.deleted']!(entryOf('event.deleted', { event: payloadEvent() }, { outboxId: 2 }));
    expect(thisWeek.refreshed).toEqual([RSO_SERVER, RSO_SERVER]);
  });
});
