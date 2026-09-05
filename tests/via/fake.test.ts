import { describe, it, expect } from 'vitest';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { ViaError } from '../../src/via/client.ts';

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
