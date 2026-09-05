import { describe, it, expect } from 'vitest';
import { unlinkCommand } from '../../src/commands/unlink.ts';
import { ViaError } from '../../src/via/client.ts';
import { interaction, testContext } from './support.ts';

describe('the unlink command', () => {
  it('is the command the identity feature declares', () => {
    expect(unlinkCommand.name).toBe('unlink');
    expect(unlinkCommand.featureId).toBe('identity.unlink');
    expect(unlinkCommand.ephemeral).toBe(true);
  });

  it('removes the link on the web platform and everything the bot held', async () => {
    const { context, via, deleted } = testContext();
    via.seedLink('204255221017214977');
    const reply = await unlinkCommand.run(interaction({ commandName: 'unlink' }), context);
    expect(await via.getLink('204255221017214977')).toBe(null);
    expect(deleted).toEqual(['204255221017214977']);
    expect(reply.content).toBe(
      'This Discord account is no longer linked to VIA, and every subscription, preference, reminder and course the bot held for it has been deleted.'
    );
  });

  it('says so in one sentence when there was no link', async () => {
    const { context } = testContext();
    const reply = await unlinkCommand.run(interaction({ commandName: 'unlink' }), context);
    expect(reply.content).toBe('This Discord account is not linked to a VIA account, so there is nothing to unlink.');
  });

  it('still clears anything the bot was holding when there was no link', async () => {
    const { context, deleted } = testContext();
    await unlinkCommand.run(interaction({ commandName: 'unlink' }), context);
    expect(deleted).toEqual(['204255221017214977']);
  });

  it('says one sentence when the web platform cannot be reached, and holds on to what it has', async () => {
    const { context, via, deleted } = testContext();
    via.failNextWith(new ViaError('The VIA web platform did not answer.', 0, 'unreachable'));
    const reply = await unlinkCommand.run(interaction({ commandName: 'unlink' }), context);
    expect(reply.content).toBe('VIA is not answering right now, so the link cannot be removed. Please try again in a few minutes.');
    // Nothing local is deleted, because the link on the web platform is still
    // there and the two would then disagree.
    expect(deleted).toEqual([]);
  });

  // The two dash characters are written as escapes, because the language
  // check reads this file as well as the ones it is asserting about.
  it('writes every sentence it shows in full, with no dash standing in for a comma', async () => {
    const { context, via } = testContext();
    via.seedLink('204255221017214977');
    const reply = await unlinkCommand.run(interaction({ commandName: 'unlink' }), context);
    expect(reply.content).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reply.content.split(/(?<=\.)\s+/)) {
      expect(sentence.trim()).toMatch(/^[A-Z].*\.$/s);
    }
  });
});
