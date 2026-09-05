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
