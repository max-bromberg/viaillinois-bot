import { describe, it, expect } from 'vitest';
import { createInterestRecorder } from '../../src/mirror/interest.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryEventMirrors } from '../support/proactive.ts';
import { memoryInterestMarks } from '../support/feed.ts';

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
    const marks = memoryInterestMarks();
    await mirrors.recordScheduledEvent(GUILD, 10, SCHEDULED);
    const record = createInterestRecorder({ via, mirrors, marks });
    return { via, mirrors, marks, record };
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

  /**
   * The bot writes down who marked interest, by Discord account, because the
   * feedback request the morning after has to reach them and the web platform
   * holds interest by NetID. It is written only once the web platform has
   * taken the signal, so the two cannot disagree.
   */
  it('writes down who marked interest, so that the morning after can reach them', async () => {
    const { via, marks, record } = await built();
    via.seedLink(ROSA);
    await record(signal(), true);
    expect(await marks.listPeople(10)).toEqual([ROSA]);
  });

  it('forgets the mark when a member takes their interest back', async () => {
    const { via, marks, record } = await built();
    via.seedLink(ROSA);
    await record(signal(), true);
    await record(signal(), false);
    expect(await marks.listPeople(10)).toEqual([]);
  });

  it('writes down the mark for somebody who is not linked as well, since they may link later', async () => {
    const { marks, record } = await built();
    await record(signal(), true);
    expect(await marks.listPeople(10)).toEqual([ROSA]);
  });

  it('writes nothing down when VIA did not take the signal', async () => {
    const { via, marks, record } = await built();
    via.seedLink(ROSA);
    via.failNextWith(new Error('VIA did not answer'));
    await record(signal(), true);
    expect(await marks.listPeople(10)).toEqual([]);
  });

  it('carries on when VIA refuses, because one interest signal is not worth a failure', async () => {
    const { via, record } = await built();
    via.failNextWith(new Error('VIA did not answer'));
    await expect(record(signal(), true)).resolves.toBeUndefined();
  });
});
