import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import { featureById } from '../../src/features/registry.ts';
import { memoryGuildStore } from '../commands/support.ts';
import { memoryDeliveries, recordingDirectMessages } from '../support/proactive.ts';

/**
 * Switching a feature off because it cannot work any more.
 *
 * A server that unbinds the channel a feature posts to, or takes away the
 * permission a feature needs, has broken that feature without meaning to.
 * Posting into nowhere and failing quietly every few minutes would be the
 * worst of both, so the feature is switched off and the manager who set the
 * bot up is told once, with the reason and what to do about it.
 *
 * Once is the point. The notice goes through Deliveries, keyed by the server
 * and the feature, so a hundred entries about the same broken feature send
 * one direct message rather than a hundred.
 */
describe('switching a feature off and telling the manager', () => {
  const GUILD = '900000000000000001';
  const MANAGER = '204255221017214977';

  async function built() {
    const guilds = memoryGuildStore();
    const deliveries = memoryDeliveries();
    const directMessages = recordingDirectMessages();
    await guilds.createInstallation(GUILD, MANAGER);
    await guilds.setKind(GUILD, 'rso');
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 1 });
    await guilds.setFeatureEnabled(GUILD, 'announce.new', true);

    const disable = createFeatureDisabler({
      guilds,
      deliveries,
      sendDirectMessage: directMessages.send,
    });
    return { guilds, deliveries, directMessages, disable };
  }

  it('switches the feature off in that server', async () => {
    const { guilds, disable } = await built();
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    expect(await guilds.isFeatureEnabled(GUILD, 'announce.new')).toBe(false);
  });

  it('tells the manager who set the bot up, with the reason and what to do', async () => {
    const { directMessages, disable } = await built();
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');

    expect(directMessages.sent).toHaveLength(1);
    expect(directMessages.sent[0]!.discordUserId).toBe(MANAGER);
    expect(directMessages.sent[0]!.content).toContain('no channel is bound to announcements');
    expect(directMessages.sent[0]!.content).toContain('config');
    expect(directMessages.sent[0]!.content).toContain(featureById('announce.new').description);
  });

  it('tells the manager once, however many entries find the same feature broken', async () => {
    const { directMessages, disable } = await built();
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    expect(directMessages.sent).toHaveLength(1);
  });

  it('tells the manager again about a different feature, because it is a different fault', async () => {
    const { directMessages, disable } = await built();
    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    await disable.disable(GUILD, 'mirror.scheduled', 'the bot does not have the Manage Events permission here');
    expect(directMessages.sent).toHaveLength(2);
  });

  it('tells a second server manager about their own server', async () => {
    const { guilds, deliveries, directMessages, disable } = await built();
    const other = '900000000000000002';
    await guilds.createInstallation(other, '301422551071492041');
    await guilds.setKind(other, 'community');
    await guilds.setBinding(other, { binding: 'all' });

    await disable.disable(GUILD, 'announce.new', 'no channel is bound to announcements');
    await disable.disable(other, 'announce.new', 'no channel is bound to announcements');

    expect(directMessages.sent.map(message => message.discordUserId))
      .toEqual([MANAGER, '301422551071492041']);
    expect(deliveries.rows()).toHaveLength(2);
  });

  it('says nothing about a server the bot holds no record of', async () => {
    const { directMessages, disable } = await built();
    await disable.disable('900000000000000009', 'announce.new', 'no channel is bound to announcements');
    expect(directMessages.sent).toEqual([]);
  });

  it('writes a notice that passes the language check', async () => {
    const { directMessages, disable } = await built();
    await disable.disable(GUILD, 'mirror.scheduled', 'the bot does not have the Manage Events permission here');

    const dir = await mkdtemp(join(tmpdir(), 'via-bot-disable-'));
    try {
      const path = join(dir, 'notice.txt');
      await writeFile(path, `${directMessages.sent[0]!.content}\n`);
      expect(findViolations([path])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
