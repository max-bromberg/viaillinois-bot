import { describe, it, expect } from 'vitest';
import { linkComponent, linkCommand, LINK_POLL_INTERVAL_MS, LINK_POLL_WINDOW_MS } from '../../src/commands/link.ts';
import { ViaError } from '../../src/via/client.ts';
import { interaction, testContext } from './support.ts';

describe('the link command', () => {
  it('is the command the identity feature declares', () => {
    expect(linkCommand.name).toBe('link');
    expect(linkCommand.featureId).toBe('identity.link');
  });

  it('answers only the person who asked', () => {
    expect(linkCommand.ephemeral).toBe(true);
  });

  it('opens a link session for the Discord account that asked', async () => {
    const { context, via } = testContext();
    await linkCommand.run(interaction(), context);
    expect(via.sessions.map(s => s.discordUserId)).toEqual(['204255221017214977']);
  });

  it('hands out the address and says how long it lasts', async () => {
    const { context, via } = testContext();
    const reply = await linkCommand.run(interaction(), context);
    const address = via.sessions[0]!.session.address;
    expect(reply.content).toContain(address);
    expect(reply.content).toContain('ten minutes');
    expect(reply.components?.[0]?.components[0]).toEqual({
      kind: 'button',
      style: 'link',
      label: 'Sign in on viaillinois.com',
      url: address,
    });
  });

  // The two dash characters are written as escapes, because the language
  // check reads this file as well as the ones it is asserting about.
  it('writes every sentence it shows in full, with no dash standing in for a comma', async () => {
    const { context } = testContext();
    const reply = await linkCommand.run(interaction(), context);
    expect(reply.content).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reply.content.split(/(?<=\.)\s+/)) {
      expect(sentence.trim()).toMatch(/^[A-Z].*\.$/s);
    }
  });

  it('waits for the link and then confirms it in one direct message naming the account', async () => {
    const { context, via, scheduled, directMessages } = testContext();
    via.seedLink('204255221017214977', { displayName: 'Rosa Garcia' }, { afterLookups: 3 });
    await linkCommand.run(interaction(), context);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(directMessages).toHaveLength(1);
    expect(directMessages[0]!.discordUserId).toBe('204255221017214977');
    expect(directMessages[0]!.content).toContain('Rosa Garcia');
    expect(directMessages[0]!.content).not.toMatch(/[\u2013\u2014]/);
  });

  it('polls no faster than the interval it names', async () => {
    const { context, via, scheduled, clockAt } = testContext();
    via.seedLink('204255221017214977', {}, { afterLookups: 2 });
    const started = clockAt().getTime();
    await linkCommand.run(interaction(), context);
    await scheduled[0]!();
    expect(clockAt().getTime() - started).toBe(3 * LINK_POLL_INTERVAL_MS);
  });

  it('stays silent when the link never happens, and gives up inside the window it named', async () => {
    const { context, scheduled, directMessages, clockAt } = testContext();
    const started = clockAt().getTime();
    await linkCommand.run(interaction(), context);
    await scheduled[0]!();
    expect(directMessages).toEqual([]);
    expect(clockAt().getTime() - started).toBeLessThanOrEqual(LINK_POLL_WINDOW_MS + LINK_POLL_INTERVAL_MS);
  });

  it('says one sentence when the web platform cannot be reached', async () => {
    const { context, via } = testContext();
    via.failNextWith(new ViaError('The VIA web platform did not answer.', 0, 'unreachable'));
    const reply = await linkCommand.run(interaction(), context);
    expect(reply.content).toBe('VIA is not answering right now, so linking cannot be started. Please try again in a few minutes.');
    expect(reply.components ?? []).toEqual([]);
  });

  it('says one sentence when VIA is busy, naming the wait it was given', async () => {
    const { context, via } = testContext();
    const { ViaBusyError } = await import('../../src/via/client.ts');
    via.failNextWith(new ViaBusyError('VIA is busy right now. Please try again in a moment.', 30));
    const reply = await linkCommand.run(interaction(), context);
    expect(reply.content).toBe('VIA is busy right now. Please try again in 30 seconds.');
  });

  it('stays silent rather than throwing when the polling itself fails', async () => {
    const { context, via, scheduled, directMessages } = testContext();
    await linkCommand.run(interaction(), context);
    via.failNextWith(new ViaError('The VIA web platform did not answer.', 0, 'unreachable'));
    await expect(scheduled[0]!()).resolves.toBeUndefined();
    expect(directMessages).toEqual([]);
  });
});

/**
 * The link button.
 *
 * Several answers offer a Link button rather than telling a person to go and
 * type the link command: the event card's reminder and interest buttons, the
 * organization card's follow button, and the refusal a manager reads when
 * binding a server needs a VIA account they do not have. The button has to do
 * what the command does, or it is a button that does nothing.
 */
describe('the link button on an answer that needs a VIA account', () => {
  it('opens a link session, exactly as the command does', async () => {
    const { context, via } = testContext();
    const reply = await linkComponent.run(
      interaction({ kind: 'button', commandName: null, customId: 'identity:link' }),
      context,
    );
    expect(via.sessions).toHaveLength(1);
    expect(reply.content).toContain(via.sessions[0]!.session.address);
  });

  it('opens the session for the person who pressed it', async () => {
    const { context, via } = testContext();
    await linkComponent.run(
      interaction({ kind: 'button', commandName: null, customId: 'identity:link', userId: '301422551071492041' }),
      context,
    );
    expect(via.sessions[0]!.discordUserId).toBe('301422551071492041');
  });

  it('answers only the person who pressed it', () => {
    expect(linkComponent.ephemeral).toBe(true);
  });
});
