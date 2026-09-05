import { describe, it, expect } from 'vitest';
import { createInterestRecorder } from '../../src/mirror/interest.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryEventMirrors } from '../support/proactive.ts';

/**
 * Interest left on a scheduled event.
 *
 * A member marks themselves interested with Discord's own control, the
 * gateway tells the bot, and the bot records it on VIA against the event the
 * scheduled event mirrors. Who they are decides how it is recorded: a linked
 * person is the acting person, and their interest is recorded by NetID, and
 * anybody else is named by their Discord identifier, which the web platform
 * records as a salted hash so that the count is honest and nobody can reverse
 * it. The bot itself holds neither.
 */
describe('recording interest from the Events tab', () => {
  const GUILD = '900000000000000001';
  const SCHEDULED = '600000000000000001';
  const ROSA = '204255221017214977';

  async function built() {
    const via = createFakeViaClient();
    const mirrors = memoryEventMirrors();
    await mirrors.recordScheduledEvent(GUILD, 10, SCHEDULED);
    const record = createInterestRecorder({ via, mirrors });
    return { via, mirrors, record };
  }

  const signal = (overrides: Record<string, unknown> = {}) => ({
    guildId: GUILD,
    scheduledEventId: SCHEDULED,
    discordUserId: ROSA,
    ...overrides,
  });

  it('records interest for a linked person as the person acting', async () => {
    const { via, record } = await built();
    via.seedLink(ROSA);
    await record(signal(), true);

    expect(via.interests).toEqual([
      { eventId: 10, interested: true, actingDiscordUserId: ROSA },
    ]);
  });

  it('records interest for somebody who is not linked by their Discord identifier', async () => {
    const { via, record } = await built();
    await record(signal(), true);

    expect(via.interests).toEqual([
      { eventId: 10, interested: true, discordUserId: ROSA },
    ]);
  });

  it('clears interest when a member takes it back', async () => {
    const { via, record } = await built();
    via.seedLink(ROSA);
    await record(signal(), false);
    expect(via.interests[0]!.interested).toBe(false);
  });

  it('records interest against the VIA event the scheduled event mirrors', async () => {
    const { via, mirrors, record } = await built();
    await mirrors.recordScheduledEvent(GUILD, 44, '600000000000000009');
    await record(signal({ scheduledEventId: '600000000000000009' }), true);
    expect(via.interests[0]!.eventId).toBe(44);
  });

  it('says nothing to VIA about a scheduled event the bot did not create', async () => {
    const { via, record } = await built();
    await record(signal({ scheduledEventId: '600000000000000099' }), true);
    expect(via.interests).toEqual([]);
  });

  it('says nothing to VIA about a signal the gateway gave no server for', async () => {
    const { via, record } = await built();
    await record(signal({ guildId: null }), true);
    expect(via.interests).toEqual([]);
  });

  it('carries on when VIA refuses, because one interest signal is not worth a failure', async () => {
    const { via, record } = await built();
    via.failNextWith(new Error('VIA did not answer'));
    await expect(record(signal(), true)).resolves.toBeUndefined();
  });
});
