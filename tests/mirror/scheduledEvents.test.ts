import { describe, it, expect } from 'vitest';
import {
  createScheduledEventMirror, MAX_SCHEDULED_EVENT_FIELD,
} from '../../src/mirror/scheduledEvents.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryGuildStore } from '../commands/support.ts';
import {
  memoryDeliveries, memoryEventMirrors, recordingActions, recordingDirectMessages,
} from '../support/proactive.ts';
import type { GuildInstallation } from '../../src/guilds/store.ts';
import type { ViaEvent } from '../../src/via/client.ts';

/**
 * Native scheduled events.
 *
 * Each upcoming event is mirrored into the server's own Events tab as a
 * Discord scheduled event, so that members can mark themselves interested
 * with Discord's own control and get Discord's own reminders. Only the
 * occurrences inside a rolling window are mirrored, two weeks by default and
 * adjustable per server, so that a term of weekly meetings does not flood the
 * tab.
 *
 * The claims tested here are the ones a server would notice: the edge of the
 * window, a series that puts only its first few meetings in the tab, an event
 * that is not mirrored twice however many times an entry is handled, and a
 * server that took the Manage Events permission away, which switches the
 * feature off rather than failing every few minutes.
 */

const GUILD = '900000000000000001';
const MANAGER = '204255221017214977';
/** Half past nine in the morning on campus, which is the clock every test runs on. */
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

async function built(options: { windowDays?: number } = {}) {
  const guilds = memoryGuildStore();
  const mirrors = memoryEventMirrors();
  const deliveries = memoryDeliveries();
  const actions = recordingActions();
  const directMessages = recordingDirectMessages();
  const via = createFakeViaClient();

  await guilds.createInstallation(GUILD, MANAGER);
  await guilds.setKind(GUILD, 'rso');
  await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 1 });
  await guilds.setFeatureEnabled(GUILD, 'mirror.scheduled', true);

  const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage: directMessages.send });
  /** The same mirror over the same rows, on whichever day the test names. */
  const mirrorAt = (when: Date) => createScheduledEventMirror({
    guilds, mirrors, deliveries, actions, via, disable, now: () => when,
  });
  const mirror = mirrorAt(NOW);

  const installation = {
    ...(await guilds.getInstallation(GUILD))!,
    ...(options.windowDays === undefined ? {} : { mirrorWindowDays: options.windowDays }),
  } as GuildInstallation;

  return { guilds, mirrors, deliveries, actions, directMessages, via, mirror, mirrorAt, installation };
}

describe('mirroring one event into the Events tab', () => {
  it('creates a scheduled event carrying the title, the place and the times', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);

    expect(actions.done).toHaveLength(1);
    const created = actions.done[0]!;
    expect(created.action).toBe('createScheduledEvent');
    expect(created.guildId).toBe(GUILD);
    expect(created.draft!.name).toBe('General meeting');
    expect(created.draft!.location).toBe('Electrical & Computer Eng Bldg 1002');
    expect(created.draft!.startTime).toBe('2026-09-10T18:00:00-05:00');
    expect(created.draft!.endTime).toBe('2026-09-10T19:00:00-05:00');
  });

  it('writes down which scheduled event mirrors which VIA event', async () => {
    const { mirror, installation, mirrors } = await built();
    await mirror.apply(installation, event(), 1);
    const held = await mirrors.get(GUILD, 10);
    expect(held!.scheduledEventId).not.toBe(null);
  });

  it('creates one scheduled event however many times the same entry is handled', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.apply(installation, event(), 1);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(1);
  });

  it('edits the scheduled event it already made rather than making a second one', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.apply(installation, event({ startTime: '2026-09-11T18:00:00-05:00' }), 2);

    const kinds = actions.done.map(one => one.action);
    expect(kinds).toEqual(['createScheduledEvent', 'editScheduledEvent']);
    expect(actions.done[1]!.draft!.startTime).toBe('2026-09-11T18:00:00-05:00');
  });

  /**
   * The bot created the scheduled event and fell over before writing down
   * that it had. The delivery row is what remembers, so the entry handled
   * again restores the mapping rather than creating a second one.
   */
  it('restores the mapping after a crash between creating and writing it down', async () => {
    const { mirror, installation, actions, mirrors } = await built();
    await mirror.apply(installation, event(), 1);
    const created = (await mirrors.get(GUILD, 10))!.scheduledEventId;
    await mirrors.recordScheduledEvent(GUILD, 10, null);

    await mirror.apply(installation, event(), 1);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(1);
    expect((await mirrors.get(GUILD, 10))!.scheduledEventId).toBe(created);
  });

  it('deletes the scheduled event when the event goes, and forgets the mapping', async () => {
    const { mirror, installation, actions, mirrors } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.remove(installation, 10);

    expect(actions.done.map(one => one.action))
      .toEqual(['createScheduledEvent', 'deleteScheduledEvent']);
    expect((await mirrors.get(GUILD, 10))!.scheduledEventId).toBe(null);
  });

  it('has nothing to delete for an event it never mirrored', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.remove(installation, 10);
    expect(actions.done).toEqual([]);
  });

  it('mirrors nothing in a server that has not switched the feature on', async () => {
    const { guilds, mirror, installation, actions } = await built();
    await guilds.setFeatureEnabled(GUILD, 'mirror.scheduled', false);
    await mirror.apply(installation, event(), 1);
    expect(actions.done).toEqual([]);
  });

  /**
   * A scheduled event is visible to everybody in the server, and an internal
   * event is for the members of one organization, so an internal event is
   * never mirrored however the server is bound.
   */
  it('never mirrors an event an organization marked internal', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ isPrivate: true }), 1);
    expect(actions.done).toEqual([]);
  });

  it('never creates a scheduled event for something that has been cancelled', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ cancelledAt: '2026-09-05T12:00:00-05:00' }), 1);
    expect(actions.done).toEqual([]);
  });

  it('deletes the scheduled event of an event that has just been cancelled', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.apply(installation, event({ cancelledAt: '2026-09-05T12:00:00-05:00' }), 2);
    expect(actions.done.map(one => one.action))
      .toEqual(['createScheduledEvent', 'deleteScheduledEvent']);
  });

  /**
   * A delivery row that was written and never posted says the scheduled event
   * is still owed. Discord refusing once must not cost the server the entry
   * for good, so the same entry handled again creates it.
   */
  it('creates a scheduled event that was owed when the entry is handled again', async () => {
    const { mirror, installation, actions, mirrors } = await built();
    actions.failNextWith(new Error('Discord did not answer.'));
    await expect(mirror.apply(installation, event(), 1)).rejects.toThrow('Discord did not answer.');
    expect(await mirrors.get(GUILD, 10)).toBe(null);

    await mirror.apply(installation, event(), 1);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(1);
    expect((await mirrors.get(GUILD, 10))!.scheduledEventId).not.toBe(null);
  });
});

/**
 * What Discord will take in a scheduled event.
 *
 * Discord refuses a scheduled event whose name or location is longer than a
 * hundred characters, and the title and the place come from VIA, which bounds
 * neither at a hundred. A refusal here is an event missing from the tab with
 * nothing in the channel to say why, so both are cut to what Discord takes.
 */
describe('what a scheduled event carries', () => {
  it('cuts a title longer than Discord will take', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ title: 'A'.repeat(140) }), 1);

    const draft = actions.done[0]!.draft!;
    expect(draft.name).toHaveLength(MAX_SCHEDULED_EVENT_FIELD);
    expect(draft.name.startsWith('A'.repeat(50))).toBe(true);
  });

  it('cuts a place longer than Discord will take', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({
      building: null,
      roomNumber: null,
      locationText: 'B'.repeat(140),
    }), 1);

    expect(actions.done[0]!.draft!.location).toHaveLength(MAX_SCHEDULED_EVENT_FIELD);
  });

  it('leaves a title and a place that already fit exactly as they are', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);

    expect(actions.done[0]!.draft!.name).toBe('General meeting');
    expect(actions.done[0]!.draft!.location).toBe('Electrical & Computer Eng Bldg 1002');
  });
});

describe('the edge of the mirroring window', () => {
  it('mirrors an occurrence on the last day of the window', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ startTime: '2026-09-19T18:00:00-05:00', endTime: '2026-09-19T19:00:00-05:00' }), 1);
    expect(actions.done).toHaveLength(1);
  });

  it('leaves an occurrence one day past the window alone', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ startTime: '2026-09-20T18:00:00-05:00', endTime: '2026-09-20T19:00:00-05:00' }), 1);
    expect(actions.done).toEqual([]);
  });

  it('leaves an occurrence that has already happened alone', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event({ startTime: '2026-09-01T18:00:00-05:00', endTime: '2026-09-01T19:00:00-05:00' }), 1);
    expect(actions.done).toEqual([]);
  });

  it('follows the window a server chose rather than the default fortnight', async () => {
    const { mirror, installation, actions } = await built({ windowDays: 3 });
    await mirror.apply(installation, event({ startTime: '2026-09-10T18:00:00-05:00' }), 1);
    expect(actions.done).toEqual([]);

    await mirror.apply(installation, event({ eventId: 11, startTime: '2026-09-07T18:00:00-05:00', endTime: '2026-09-07T19:00:00-05:00' }), 2);
    expect(actions.done).toHaveLength(1);
  });

  it('edits a scheduled event that has moved past the window rather than deleting it', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.apply(installation, event({ startTime: '2026-10-20T18:00:00-05:00', endTime: '2026-10-20T19:00:00-05:00' }), 2);
    expect(actions.done.map(one => one.action))
      .toEqual(['createScheduledEvent', 'editScheduledEvent']);
  });
});

describe('rolling the window forward over a series', () => {
  async function withSeries() {
    const helpers = await built();
    helpers.via.clearEvents();
    // A weekly meeting on the Thursday, four of them, so that two fall inside
    // the fortnight and two fall outside it.
    helpers.via.seedEvent({ eventId: 10, startTime: '2026-09-10T18:00:00-05:00', endTime: '2026-09-10T19:00:00-05:00', seriesId: 4 });
    helpers.via.seedEvent({ eventId: 11, startTime: '2026-09-17T18:00:00-05:00', endTime: '2026-09-17T19:00:00-05:00', seriesId: 4 });
    helpers.via.seedEvent({ eventId: 12, startTime: '2026-09-24T18:00:00-05:00', endTime: '2026-09-24T19:00:00-05:00', seriesId: 4 });
    helpers.via.seedEvent({ eventId: 13, startTime: '2026-10-01T18:00:00-05:00', endTime: '2026-10-01T19:00:00-05:00', seriesId: 4 });
    return helpers;
  }

  it('mirrors only the occurrences inside the window', async () => {
    const { mirror, installation, actions } = await withSeries();
    await mirror.rollGuild(installation);

    const names = actions.done.filter(one => one.action === 'createScheduledEvent');
    expect(names).toHaveLength(2);
  });

  it('mirrors the occurrences that have entered the window on a later day', async () => {
    const { mirror, mirrorAt, installation, actions, mirrors } = await withSeries();
    await mirror.rollGuild(installation);
    expect(await mirrors.get(GUILD, 12)).toBe(null);

    await mirrorAt(new Date('2026-09-15T14:30:00Z')).rollGuild(installation);
    expect((await mirrors.get(GUILD, 12))!.scheduledEventId).not.toBe(null);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(3);
  });

  it('rolls nothing in a server that has not switched the feature on', async () => {
    const { guilds, mirror, installation, actions } = await withSeries();
    await guilds.setFeatureEnabled(GUILD, 'mirror.scheduled', false);
    await mirror.rollGuild(installation);
    expect(actions.done).toEqual([]);
  });

  /**
   * A roll belongs to no outbox entry, so a delivery row keyed by one would
   * be the same row for every roll the server ever makes. The row that says
   * whether an event is in the tab is the Event_Mirrors row, which is why the
   * roll asks that rather than Deliveries, and why an occurrence whose
   * scheduled event has gone is made again on the next roll.
   */
  it('creates the scheduled event again after the one it made was deleted', async () => {
    const { mirror, installation, actions, mirrors } = await withSeries();
    await mirror.rollGuild(installation);
    await mirror.remove(installation, 10);
    expect((await mirrors.get(GUILD, 10))!.scheduledEventId).toBe(null);

    await mirror.rollGuild(installation);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(3);
    expect((await mirrors.get(GUILD, 10))!.scheduledEventId).not.toBe(null);
  });

  it('writes no delivery row for the occurrences a roll creates', async () => {
    const { mirror, installation, deliveries } = await withSeries();
    await mirror.rollGuild(installation);
    expect(deliveries.rows()).toEqual([]);
  });
});

describe('a server that took the Manage Events permission away', () => {
  async function withoutPermission() {
    const helpers = await built();
    helpers.actions.setPermissions(GUILD, ['ViewChannel', 'SendMessages']);
    return helpers;
  }

  it('creates nothing, because it cannot', async () => {
    const { mirror, installation, actions } = await withoutPermission();
    await mirror.apply(installation, event(), 1);
    expect(actions.done).toEqual([]);
  });

  it('switches the feature off rather than failing every few minutes', async () => {
    const { guilds, mirror, installation } = await withoutPermission();
    await mirror.apply(installation, event(), 1);
    expect(await guilds.isFeatureEnabled(GUILD, 'mirror.scheduled')).toBe(false);
  });

  it('tells the manager once, naming the permission Discord names', async () => {
    const { mirror, installation, directMessages, guilds } = await withoutPermission();
    await mirror.apply(installation, event(), 1);
    await guilds.setFeatureEnabled(GUILD, 'mirror.scheduled', true);
    await mirror.apply(installation, event({ eventId: 11 }), 2);

    expect(directMessages.sent).toHaveLength(1);
    expect(directMessages.sent[0]!.discordUserId).toBe(MANAGER);
    expect(directMessages.sent[0]!.content).toContain('Manage Events');
  });

  it('mirrors as usual for a server whose bot holds the permission through Administrator', async () => {
    const { mirror, installation, actions } = await built();
    actions.setPermissions(GUILD, ['Administrator']);
    await mirror.apply(installation, event(), 1);
    expect(actions.done).toHaveLength(1);
  });
});

describe('clearing what the bot put into a server', () => {
  it('deletes every scheduled event it created there and forgets the rows', async () => {
    const { mirror, installation, actions, mirrors } = await built();
    await mirror.apply(installation, event(), 1);
    await mirror.apply(installation, event({ eventId: 11, startTime: '2026-09-11T18:00:00-05:00', endTime: '2026-09-11T19:00:00-05:00' }), 2);

    const cleared = await mirror.removeGuildPresence(GUILD);
    expect(cleared.scheduledEvents).toBe(2);
    expect(actions.done.filter(one => one.action === 'deleteScheduledEvent')).toHaveLength(2);
    expect(await mirrors.listByGuild(GUILD)).toEqual([]);
  });

  it('says it cleared nothing for a server the bot posted nothing in', async () => {
    const { mirror } = await built();
    expect(await mirror.removeGuildPresence(GUILD)).toEqual({ scheduledEvents: 0, unpinnedMessages: 0 });
  });

  /**
   * The living this week message is the one message the bot pins, and section
   * 5 of the design has removal unpin it along with everything else the bot
   * put into the server.
   */
  it('unpins the messages it pinned there and forgets where they were', async () => {
    const { mirror, guilds, actions } = await built();
    await guilds.setGuildMessage(GUILD, 'thisweek', {
      channelId: '700000000000000001',
      messageId: '800000000000000001',
    });

    const cleared = await mirror.removeGuildPresence(GUILD);
    expect(cleared.unpinnedMessages).toBe(1);
    expect(actions.done.filter(one => one.action === 'unpin')).toHaveLength(1);
    expect(await guilds.listGuildMessages(GUILD)).toEqual([]);
  });

  it('carries on when the message it pinned is no longer there', async () => {
    const { mirror, guilds, actions } = await built();
    await guilds.setGuildMessage(GUILD, 'thisweek', {
      channelId: '700000000000000001',
      messageId: '800000000000000001',
    });
    actions.failNextWith(Object.assign(new Error('Unknown Message'), { code: 10008 }));

    const cleared = await mirror.removeGuildPresence(GUILD);
    expect(cleared.unpinnedMessages).toBe(0);
    expect(await guilds.listGuildMessages(GUILD)).toEqual([]);
  });

  it('carries on when Discord has already forgotten one of the scheduled events', async () => {
    const { mirror, installation, actions } = await built();
    await mirror.apply(installation, event(), 1);
    actions.failNextWith(Object.assign(new Error('Unknown Guild Scheduled Event'), { code: 10070 }));

    const cleared = await mirror.removeGuildPresence(GUILD);
    expect(cleared.scheduledEvents).toBe(0);
  });
});
