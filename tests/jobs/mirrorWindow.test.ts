import { describe, it, expect } from 'vitest';
import { createMirrorWindowJob } from '../../src/jobs/mirrorWindow.ts';
import { createScheduledEventMirror } from '../../src/mirror/scheduledEvents.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryGuildStore } from '../commands/support.ts';
import {
  memoryDeliveries, memoryEventMirrors, recordingActions, recordingDirectMessages,
} from '../support/proactive.ts';

/**
 * The daily roll of the mirroring window.
 *
 * The window is a fortnight by default, so a term of weekly meetings puts two
 * meetings in the Events tab rather than sixteen, and the window has to move.
 * The job is what moves it: once a day it looks at every server that has
 * switched mirroring on and creates the scheduled events for the occurrences
 * that have entered the window since yesterday. Nothing is deleted, because an
 * occurrence that has left the window has happened.
 */
describe('rolling the mirroring window forward', () => {
  const FIRST = '900000000000000001';
  const SECOND = '900000000000000002';
  const MANAGER = '204255221017214977';

  async function built(now: Date) {
    const guilds = memoryGuildStore();
    const mirrors = memoryEventMirrors();
    const deliveries = memoryDeliveries();
    const actions = recordingActions();
    const directMessages = recordingDirectMessages();
    const via = createFakeViaClient();
    const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage: directMessages.send });

    const clock = { at: now };
    const mirror = createScheduledEventMirror({
      guilds, mirrors, deliveries, actions, via, disable, now: () => clock.at,
    });
    const waits: number[] = [];
    const job = createMirrorWindowJob({
      guilds,
      mirror,
      now: () => clock.at,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); },
    });

    via.clearEvents();
    via.seedEvent({ eventId: 10, startTime: '2026-09-10T18:00:00-05:00', endTime: '2026-09-10T19:00:00-05:00', seriesId: 4 });
    via.seedEvent({ eventId: 11, startTime: '2026-09-17T18:00:00-05:00', endTime: '2026-09-17T19:00:00-05:00', seriesId: 4 });
    via.seedEvent({ eventId: 12, startTime: '2026-09-24T18:00:00-05:00', endTime: '2026-09-24T19:00:00-05:00', seriesId: 4 });

    return { guilds, mirrors, actions, via, mirror, job, clock, waits };
  }

  async function setUp(guilds: ReturnType<typeof memoryGuildStore>, guildId: string, mirroring: boolean) {
    await guilds.createInstallation(guildId, MANAGER);
    await guilds.setKind(guildId, 'rso');
    await guilds.setBinding(guildId, { binding: 'rso', rsoId: 1 });
    await guilds.setFeatureEnabled(guildId, 'mirror.scheduled', mirroring);
  }

  it('mirrors what is inside the window today, in every server that asked for it', async () => {
    const { guilds, job, actions } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, true);
    await setUp(guilds, SECOND, true);

    const rolled = await job.runOnce();
    expect(rolled.servers).toBe(2);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(4);
  });

  it('creates what has entered the window since the last run, and nothing else', async () => {
    const { guilds, job, actions, clock, mirrors } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, true);

    await job.runOnce();
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(2);

    clock.at = new Date('2026-09-12T14:30:00Z');
    await job.runOnce();
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(3);
    expect((await mirrors.get(FIRST, 12))!.scheduledEventId).not.toBe(null);
  });

  it('leaves what has left the window alone, because it has happened', async () => {
    const { guilds, job, actions, clock, mirrors } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, true);
    await job.runOnce();

    clock.at = new Date('2026-09-19T14:30:00Z');
    await job.runOnce();

    expect(actions.done.filter(one => one.action === 'deleteScheduledEvent')).toEqual([]);
    expect((await mirrors.get(FIRST, 10))!.scheduledEventId).not.toBe(null);
  });

  it('passes over a server that has not switched mirroring on', async () => {
    const { guilds, job, actions } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, false);
    await job.runOnce();
    expect(actions.done).toEqual([]);
  });

  it('passes over a server that has never been set up', async () => {
    const { guilds, job, actions } = await built(new Date('2026-09-05T14:30:00Z'));
    await guilds.createInstallation(FIRST, MANAGER);
    const rolled = await job.runOnce();
    expect(rolled.servers).toBe(0);
    expect(actions.done).toEqual([]);
  });

  it('carries on to the next server when one of them fails', async () => {
    const { guilds, job, actions, via } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, true);
    await setUp(guilds, SECOND, true);
    via.failNextWith(new Error('VIA did not answer'));

    const rolled = await job.runOnce();
    expect(rolled.failed).toBe(1);
    expect(actions.done.filter(one => one.action === 'createScheduledEvent')).toHaveLength(2);
  });

  it('runs, waits a day, and runs again until it is stopped', async () => {
    const { guilds, mirror, clock, waits } = await built(new Date('2026-09-05T14:30:00Z'));
    await setUp(guilds, FIRST, true);

    const job = createMirrorWindowJob({
      guilds,
      mirror,
      now: () => clock.at,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
        if (waits.length >= 2) void job.stop();
      },
    });

    await job.start();
    expect(waits).toEqual([24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
  });
});
