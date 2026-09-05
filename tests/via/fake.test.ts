import { describe, it, expect } from 'vitest';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { ViaError, outboxEvent, outboxSeries } from '../../src/via/client.ts';

describe('the fake web platform client', () => {
  it('opens a link session on the address shape the recorded answer carries', async () => {
    const via = createFakeViaClient();
    const session = await via.openLinkSession('204255221017214977');
    expect(session.address.startsWith('https://viaillinois.com/link/discord/')).toBe(true);
    expect(session.address.endsWith(session.sessionId)).toBe(true);
    expect(session.expiresAt).not.toBe('');
    expect(via.sessions).toEqual([{ discordUserId: '204255221017214977', session }]);
  });

  it('gives each session its own identifier', async () => {
    const via = createFakeViaClient();
    const first = await via.openLinkSession('204255221017214977');
    const second = await via.openLinkSession('301422551071492041');
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('answers with no link until a test seeds one', async () => {
    const via = createFakeViaClient();
    expect(await via.getLink('204255221017214977')).toBe(null);
    const seeded = via.seedLink('204255221017214977', { displayName: 'Rosa Garcia' });
    const link = await via.getLink('204255221017214977');
    expect(link).toEqual(seeded);
    expect(link!.displayName).toBe('Rosa Garcia');
    expect(link!.netId).not.toBe('');
  });

  it('resolves a link only after the number of lookups a test asks for, so polling can be tested', async () => {
    const via = createFakeViaClient();
    via.seedLink('204255221017214977', { displayName: 'Rosa Garcia' }, { afterLookups: 2 });
    expect(await via.getLink('204255221017214977')).toBe(null);
    expect(await via.getLink('204255221017214977')).toBe(null);
    expect((await via.getLink('204255221017214977'))!.displayName).toBe('Rosa Garcia');
  });

  it('says whether unlinking removed a link, and removes it', async () => {
    const via = createFakeViaClient();
    via.seedLink('204255221017214977');
    expect(await via.unlink('204255221017214977')).toBe(true);
    expect(await via.getLink('204255221017214977')).toBe(null);
    expect(await via.unlink('204255221017214977')).toBe(false);
  });

  it('reports health, and can be told to report the web platform as down', async () => {
    const via = createFakeViaClient();
    expect(await via.health()).toBe(true);
    via.setHealthy(false);
    expect(await via.health()).toBe(false);
  });

  it('can be told to refuse, so the failure path of a command is testable', async () => {
    const via = createFakeViaClient();
    via.failNextWith(new ViaError('VIA is not answering.', 0, 'unreachable'));
    const failure = await via.openLinkSession('204255221017214977').then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    // Only the next call fails, so a test can assert on the recovery too.
    expect(await via.openLinkSession('204255221017214977')).toBeTruthy();
  });
});

/**
 * The reading side of the fake.
 *
 * Everything it answers comes from the recorded fixtures, so a command tested
 * against it is tested against the shapes the web platform really sends. The
 * two rules it models rather than serves are the two the web platform decides:
 * who may see an internal event, and who may bind a server to an organization.
 */
describe('reading from the fake web platform client', () => {
  it('lists the organizations the recorded answer carries', async () => {
    const via = createFakeViaClient();
    const rsos = await via.listRsos();
    expect(rsos.map(rso => rso.name)).toEqual(['IEEE']);
    expect(rsos[0]!.rsoId).toBe(1);
  });

  it('lists an organization a test seeded alongside the recorded one', async () => {
    const via = createFakeViaClient();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    expect((await via.listRsos()).map(rso => rso.name).sort()).toEqual(['HKN', 'IEEE']);
  });

  it('answers one organization with the events it has coming up', async () => {
    const via = createFakeViaClient();
    const answer = await via.getRso(1);
    expect(answer!.rso.name).toBe('IEEE');
    expect(answer!.events.map(event => event.eventId)).toEqual([10]);
  });

  it('answers with nothing for an organization nothing seeded', async () => {
    const via = createFakeViaClient();
    expect(await via.getRso(404)).toBe(null);
  });

  it('lists the recorded event, with how many there are in all', async () => {
    const via = createFakeViaClient();
    const answer = await via.listEvents({});
    expect(answer.total).toBe(1);
    expect(answer.events[0]!.title).toBe('General meeting');
  });

  it('lists only the organizations a listing named', async () => {
    const via = createFakeViaClient();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    via.seedEvent({ eventId: 20, rsoId: 9, rsoName: 'HKN', title: 'Tutoring' });
    expect((await via.listEvents({ rsoIds: [9] })).events.map(e => e.eventId)).toEqual([20]);
  });

  it('lists events in the window a listing named', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 21, title: 'Later meeting', startTime: '2026-10-01T18:00:00-05:00' });
    const answer = await via.listEvents({ from: '2026-09-01', to: '2026-09-30' });
    expect(answer.events.map(e => e.eventId)).toEqual([10]);
  });

  it('pages a listing, and still says how many events there are in all', async () => {
    const via = createFakeViaClient();
    for (let index = 0; index < 8; index++) {
      via.seedEvent({
        eventId: 100 + index,
        title: `Meeting ${index}`,
        startTime: `2026-09-${String(11 + index).padStart(2, '0')}T18:00:00-05:00`,
      });
    }
    const page = await via.listEvents({ limit: 5, offset: 5 });
    expect(page.total).toBe(9);
    expect(page.events).toHaveLength(4);
  });

  it('never shows an internal event to somebody who did not ask for one', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 30, title: 'Board sync', isPrivate: true });
    via.seedLink('204255221017214977', {
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }],
    });
    const answer = await via.listEvents({ actingDiscordUserId: '204255221017214977' });
    expect(answer.events.map(e => e.eventId)).toEqual([10]);
  });

  it('never shows an internal event to somebody who is not linked, however they ask', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 30, title: 'Board sync', isPrivate: true });
    const answer = await via.listEvents({
      includeInternal: true,
      actingDiscordUserId: '301422551071492041',
    });
    expect(answer.events.map(e => e.eventId)).toEqual([10]);
  });

  it('shows an internal event to a member of that organization who asked for it', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 30, title: 'Board sync', isPrivate: true });
    via.seedLink('204255221017214977', {
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }],
    });
    const answer = await via.listEvents({
      includeInternal: true,
      actingDiscordUserId: '204255221017214977',
    });
    expect(answer.events.map(e => e.eventId).sort()).toEqual([10, 30]);
  });

  it('answers one event, and refuses an internal one to somebody who may not see it', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 30, title: 'Board sync', isPrivate: true });
    expect((await via.getEvent(10))!.title).toBe('General meeting');
    expect(await via.getEvent(30)).toBe(null);
    via.seedLink('204255221017214977', {
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }],
    });
    expect((await via.getEvent(30, '204255221017214977'))!.title).toBe('Board sync');
  });

  it('answers the calendar file the recorded answer carries', async () => {
    const via = createFakeViaClient();
    const calendar = await via.getEventCalendar(10);
    expect(calendar.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(calendar).toContain('SUMMARY:General meeting');
  });

  it('refuses a calendar file for an event nothing seeded', async () => {
    const via = createFakeViaClient();
    const failure = await via.getEventCalendar(404).then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('not_found');
  });

  it('counts the reading calls it answered, so caching can be tested', async () => {
    const via = createFakeViaClient();
    await via.listRsos();
    await via.listRsos();
    await via.listEvents({ rsoIds: [1] });
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(2);
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(1);
  });
});

describe('confirming a binding through the fake', () => {
  it('confirms it for a board member of that organization', async () => {
    const via = createFakeViaClient();
    via.seedLink('204255221017214977', {
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }],
    });
    await expect(via.confirmBinding(1, '204255221017214977')).resolves.toBeUndefined();
  });

  it('confirms it for a global administrator of VIA, whatever they are a member of', async () => {
    const via = createFakeViaClient();
    via.seedLink('204255221017214977', { isGlobalAdmin: true, memberships: [] });
    await expect(via.confirmBinding(1, '204255221017214977')).resolves.toBeUndefined();
  });

  it('refuses a member who is not on that board', async () => {
    const via = createFakeViaClient();
    via.seedLink('204255221017214977', {
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }],
    });
    const failure = await via.confirmBinding(1, '204255221017214977').then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('forbidden');
  });

  it('refuses somebody who has no VIA account at all, and says which it is', async () => {
    const via = createFakeViaClient();
    const failure = await via.confirmBinding(1, '204255221017214977').then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('not_linked');
  });
});

describe('the outbox through the fake', () => {
  it('has nothing to read until a test seeds an entry', async () => {
    const via = createFakeViaClient();
    const page = await via.readOutbox({ after: 0 });
    expect(page.entries).toEqual([]);
    expect(page.nextAfter).toBe(null);
  });

  it('seeds an entry from the recorded entry of that kind, so the shape is the web platform shape', async () => {
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    const [entry] = (await via.readOutbox({ after: 0 })).entries;
    expect(entry!.kind).toBe('event.created');
    expect(entry!.subjectType).toBe('event');
    expect(entry!.rsoId).toBe(1);
    expect(outboxEvent(entry!)!.title).toBe('General meeting');
  });

  it('numbers seeded entries in the order they were seeded', async () => {
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    via.seedOutbox('event.updated');
    via.seedOutbox('series.created');
    const page = await via.readOutbox({ after: 0 });
    expect(page.entries.map(entry => entry.outboxId)).toEqual([1, 2, 3]);
    expect(page.entries.map(entry => entry.kind))
      .toEqual(['event.created', 'event.updated', 'series.created']);
    expect(page.nextAfter).toBe(3);
  });

  it('answers only with the entries after the cursor it was given', async () => {
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    via.seedOutbox('event.updated');
    const page = await via.readOutbox({ after: 1 });
    expect(page.entries.map(entry => entry.outboxId)).toEqual([2]);
  });

  it('answers with at most the number of entries it was asked for', async () => {
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    via.seedOutbox('event.updated');
    via.seedOutbox('event.cancelled');
    const page = await via.readOutbox({ after: 0, limit: 2 });
    expect(page.entries.map(entry => entry.outboxId)).toEqual([1, 2]);
    expect(page.nextAfter).toBe(2);
  });

  it('lets a test say what an entry is about, so one event is not every event', async () => {
    const via = createFakeViaClient();
    const event = via.seedEvent({ eventId: 44, title: 'Soldering night', rsoId: 9 });
    via.seedOutbox('event.created', { rsoId: 9, subjectId: '44', payload: { event } });
    const [entry] = (await via.readOutbox({ after: 0 })).entries;
    expect(entry!.rsoId).toBe(9);
    expect(outboxEvent(entry!)!.title).toBe('Soldering night');
  });

  it('seeds a series entry with the events it holds', async () => {
    const via = createFakeViaClient();
    via.seedOutbox('series.created');
    const [entry] = (await via.readOutbox({ after: 0 })).entries;
    const change = outboxSeries(entry!)!;
    expect(change.series.seriesId).toBe(4);
    expect(change.series.endsOn).toBe('2026-12-09');
    expect(change.eventIds).toEqual([10, 11, 12]);
  });

  it('refuses to seed a kind the web platform does not write', () => {
    const via = createFakeViaClient();
    expect(() => via.seedOutbox('event.exploded')).toThrow('event.exploded');
  });
});

describe('interest through the fake', () => {
  it('counts a person who marks interest, and says how many are interested', async () => {
    const via = createFakeViaClient();
    const event = via.seedEvent({ eventId: 10, interestCount: 3 });
    const answer = await via.setInterest(event.eventId, {
      interested: true,
      actingDiscordUserId: '204255221017214977',
    });
    expect(answer.ok).toBe(true);
    expect(answer.interestCount).toBe(4);
    expect((await via.getEvent(10))!.interestCount).toBe(4);
  });

  it('counts one person once, however many times they press the button', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 10, interestCount: 3 });
    await via.setInterest(10, { interested: true, actingDiscordUserId: '204255221017214977' });
    const answer = await via.setInterest(10, { interested: true, actingDiscordUserId: '204255221017214977' });
    expect(answer.interestCount).toBe(4);
  });

  it('takes the count back down when a person clears their interest', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 10, interestCount: 3 });
    await via.setInterest(10, { interested: true, discordUserId: '301422551071492041' });
    const answer = await via.setInterest(10, { interested: false, discordUserId: '301422551071492041' });
    expect(answer.interestCount).toBe(3);
  });

  it('records who the signal came from, so the acting header can be tested', async () => {
    const via = createFakeViaClient();
    via.seedEvent({ eventId: 10 });
    await via.setInterest(10, { interested: true, actingDiscordUserId: '204255221017214977' });
    await via.setInterest(10, { interested: false, discordUserId: '301422551071492041' });
    expect(via.interests).toEqual([
      { eventId: 10, interested: true, actingDiscordUserId: '204255221017214977' },
      { eventId: 10, interested: false, discordUserId: '301422551071492041' },
    ]);
  });

  it('refuses interest in an event nothing seeded', async () => {
    const via = createFakeViaClient();
    via.clearEvents();
    const failure = await via.setInterest(10, { interested: true, discordUserId: '1' })
      .then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('not_found');
  });
});
