import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import {
  setupCommand, configCommand, removeCommand, setupComponent,
  NOT_A_MANAGER_MESSAGE, GUILD_ONLY_MESSAGE, NOT_LINKED_TO_BIND_MESSAGE,
  blockedReason, renderFeatureList, toggleFeature, CATEGORY_ORDER,
  MAX_MESSAGE_LENGTH, MAX_ROWS,
} from '../../src/commands/setup.ts';
import {
  featureById, features, MAX_SELECT_OPTIONS, type Feature,
} from '../../src/features/registry.ts';
import type { Interaction, Reply, ReplySelect } from '../../src/discord/adapter.ts';
import { interaction, testContext } from './support.ts';

/**
 * Setup and configuration.
 *
 * Every panel is one ephemeral message that changes as a server manager works
 * through it, so these tests press a component and read the message that comes
 * back. The claims that matter are the ones a server owner would care about:
 * only a manager reaches any of this, a server is bound to an organization
 * only when VIA agrees the person may bind it, and a feature that cannot work
 * says why rather than switching on and doing nothing.
 */

const GUILD = '900000000000000001';
const ROSA = '204255221017214977';

const manager = (overrides: Partial<Interaction> = {}): Interaction => interaction({
  commandName: 'via setup',
  guildId: GUILD,
  memberPermissions: ['ManageGuild'],
  ...overrides,
});

const press = (customId: string, overrides: Partial<Interaction> = {}) => manager({
  kind: 'button',
  commandName: null,
  customId,
  ...overrides,
});

const choose = (customId: string, values: string[], overrides: Partial<Interaction> = {}) => manager({
  kind: 'select',
  commandName: null,
  customId,
  values,
  ...overrides,
});

function selectIn(reply: Reply, customId: string): ReplySelect | undefined {
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'select' && component.customId === customId) return component;
    }
  }
  return undefined;
}

function labelsOf(reply: Reply): string[] {
  return (reply.components ?? []).flatMap(row =>
    row.components.map(component => (component.kind === 'button' ? component.label : '')));
}

function customIdsOf(reply: Reply): string[] {
  return (reply.components ?? []).flatMap(row =>
    row.components.map(component =>
      (component.kind === 'button' ? component.customId ?? '' : component.customId)));
}

describe('who may reach the setup panels', () => {
  it('answers only the person who ran it, so a channel does not read the server settings', () => {
    expect(setupCommand.ephemeral).toBe(true);
    expect(configCommand.ephemeral).toBe(true);
    expect(removeCommand.ephemeral).toBe(true);
  });

  it('refuses somebody without the Manage Server permission', async () => {
    const { context } = testContext();
    const reply = await setupCommand.run(manager({ memberPermissions: [] }), context);
    expect(reply.content).toBe(NOT_A_MANAGER_MESSAGE);
    expect(reply.components ?? []).toEqual([]);
  });

  it('refuses somebody without the permission on a panel as well as on the command', async () => {
    const { context } = testContext();
    const reply = await setupComponent.run(press('setup:step:kind', { memberPermissions: [] }), context);
    expect(reply.content).toBe(NOT_A_MANAGER_MESSAGE);
  });

  it('lets a server administrator through, since Discord counts that as every permission', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await setupCommand.run(manager({ memberPermissions: ['Administrator'] }), context);
    expect(reply.content).not.toBe(NOT_A_MANAGER_MESSAGE);
  });

  it('says setup belongs in a server when it is run outside one', async () => {
    const { context } = testContext();
    const reply = await setupCommand.run(
      manager({ guildId: null, context: 'botDm', memberPermissions: [] }),
      context,
    );
    expect(reply.content).toBe(GUILD_ONLY_MESSAGE);
  });

  it('records a server that reached setup without a join event ever arriving', async () => {
    const { context, guilds } = testContext();
    await setupCommand.run(manager(), context);
    expect(await guilds.getInstallation(GUILD)).not.toBeNull();
  });
});

describe('the panels, in the order setup walks through them', () => {
  async function started() {
    const started = testContext();
    await started.guilds.createInstallation(GUILD, ROSA);
    return started;
  }

  it('opens on the kind of server, which is the first question', async () => {
    const { context } = await started();
    const reply = await setupCommand.run(manager(), context);
    expect(reply.content).toContain('kind of server');
    expect(selectIn(reply, 'setup:kind')!.options!.map(o => o.value)).toEqual(['rso', 'community']);
  });

  it('records the kind and moves on to the binding', async () => {
    const { context, guilds } = await started();
    const reply = await setupComponent.run(choose('setup:kind', ['community']), context);
    expect((await guilds.getInstallation(GUILD))!.kind).toBe('community');
    expect(reply.content).toContain('organizations');
    expect(selectIn(reply, 'setup:binding')!.options!.map(o => o.value)).toEqual(['rso', 'all', 'set']);
  });

  it('shows the kind already chosen when the panel is opened again', async () => {
    const { context, guilds } = await started();
    await guilds.setKind(GUILD, 'rso');
    const reply = await setupComponent.run(press('setup:step:kind'), context);
    const chosen = selectIn(reply, 'setup:kind')!.options!.find(o => o.selected);
    expect(chosen!.value).toBe('rso');
  });

  it('binds a server to all of ECE without asking VIA anything', async () => {
    const { context, guilds, via } = await started();
    const reply = await setupComponent.run(choose('setup:binding', ['all']), context);
    expect((await guilds.getInstallation(GUILD))!.binding).toBe('all');
    expect(via.calls).not.toContain('confirmBinding');
    expect(reply.content).toContain('channel');
  });

  it('offers the organizations to choose from when the binding is a chosen set', async () => {
    const { context, via } = await started();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    const reply = await setupComponent.run(choose('setup:binding', ['set']), context);
    const select = selectIn(reply, 'setup:followed')!;
    expect(select.options!.map(o => o.label).sort()).toEqual(['HKN', 'IEEE']);
    expect(select.maxValues).toBeGreaterThan(1);
  });

  it('records the chosen set, and replaces it when it is chosen again', async () => {
    const { context, guilds, via } = await started();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    await setupComponent.run(choose('setup:followed', ['1', '9']), context);
    expect(await guilds.listFollowedRsos(GUILD)).toEqual([1, 9]);
    expect((await guilds.getInstallation(GUILD))!.binding).toBe('set');

    await setupComponent.run(choose('setup:followed', ['9']), context);
    expect(await guilds.listFollowedRsos(GUILD)).toEqual([9]);
  });

  it('offers the organizations to bind to when the binding is one of them', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(choose('setup:binding', ['rso']), context);
    expect(selectIn(reply, 'setup:bindrso')!.options!.map(o => o.value)).toEqual(['1']);
    expect(reply.content).toContain('board');
  });

  it('moves from the binding to the channels once the binding is settled', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:channels'), context);
    expect(reply.content).toContain('channel');
    expect(selectIn(reply, 'setup:purpose')).toBeDefined();
  });

  it('offers a channel menu for the purpose a manager chose', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(choose('setup:purpose', ['announcements']), context);
    const select = selectIn(reply, 'setup:channel:announcements')!;
    expect(select.selectKind).toBe('channel');
  });

  it('binds the channel a manager chose and says which purpose it is for', async () => {
    const { context, guilds } = await started();
    const reply = await setupComponent.run(
      choose('setup:channel:announcements', ['700000000000000001']),
      context,
    );
    expect(await guilds.listChannels(GUILD)).toEqual({ announcements: '700000000000000001' });
    expect(reply.content).toContain('announcements');
    expect(reply.content).toContain('<#700000000000000001>');
  });

  it('unbinds a purpose a manager no longer wants the bot posting in', async () => {
    const { context, guilds } = await started();
    await guilds.bindChannel(GUILD, 'announcements', '700000000000000001');
    await setupComponent.run(press('setup:unbind:announcements'), context);
    expect(await guilds.listChannels(GUILD)).toEqual({});
  });

  it('moves from the channels to the features', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:features'), context);
    expect(reply.content).toContain('Step 4 of 5');
    expect(selectIn(reply, 'setup:feature')).toBeDefined();
  });

  /**
   * The fifth panel is when the timed posts happen. Its defaults are the ones
   * the design names, Sunday at six in the evening and an hour of notice, so a
   * manager who never opens it still gets a digest at a sensible hour.
   */
  it('moves from the features to the timing, and writes the defaults out', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:timing'), context);

    expect(reply.content).toContain('Step 5 of 5');
    expect(reply.content).toContain('Sunday');
    expect(reply.content).toContain('6 in the evening');
    expect(reply.content).toContain('60 minutes');
    expect(reply.content).toContain('not pinned');
  });

  it('changes the day and the hour the weekly digest is posted at', async () => {
    const { context, guilds } = await started();
    await setupComponent.run(choose('setup:digestday', ['3']), context);
    await setupComponent.run(choose('setup:digesthour', ['9']), context);

    const installation = (await guilds.getInstallation(GUILD))!;
    expect(installation.digestDay).toBe(3);
    expect(installation.digestHour).toBe(9);
  });

  it('changes how far ahead the day of reminders are posted', async () => {
    const { context, guilds } = await started();
    await setupComponent.run(choose('setup:lead', ['120']), context);
    expect((await guilds.getInstallation(GUILD))!.reminderLeadMinutes).toBe(120);
  });

  it('turns the pinning of the digest on and off again', async () => {
    const { context, guilds } = await started();
    await setupComponent.run(press('setup:pinned'), context);
    expect((await guilds.getInstallation(GUILD))!.digestPinned).toBe(true);

    await setupComponent.run(press('setup:pinned'), context);
    expect((await guilds.getInstallation(GUILD))!.digestPinned).toBe(false);
  });

  /**
   * The features panel is one page per category, because the registry has more
   * features than Discord will carry in one message or offer in one menu. The
   * page lists the features of that category a line each, and what each of
   * them does is on the menu entry that switches it, which is where Discord
   * has room for it.
   */
  it('opens the features panel on the commands, and lists every command feature with its state', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:features'), context);

    expect(reply.content).toContain('Step 4 of 5');
    expect(reply.content).toContain('Commands');
    for (const feature of features.filter(f => f.category === 'command')) {
      expect(reply.content).toContain(feature.id);
    }
    for (const feature of features.filter(f => f.category === 'proactive')) {
      expect(reply.content).not.toContain(feature.id);
    }
  });

  it('offers every category as a page of its own', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:features'), context);
    expect(selectIn(reply, 'setup:category')!.options!.map(option => option.value))
      .toEqual(['command', 'proactive', 'roles', 'administration']);
  });

  it('turns to the page a manager chose, and offers only that page features to switch', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(choose('setup:category', ['proactive']), context);

    expect(reply.content).toContain('Proactive posts');
    const inCategory = features.filter(f => f.category === 'proactive').map(f => f.id);
    expect(selectIn(reply, 'setup:feature')!.options!.map(option => option.value)).toEqual(inCategory);
  });

  it('says what each feature does on the menu entry that switches it', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:features'), context);
    const options = selectIn(reply, 'setup:feature')!.options!;
    for (const option of options) {
      expect(option.description).toBe(featureById(option.value).summary);
    }
  });

  it('stays on the page a feature belongs to when that feature is switched', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(choose('setup:feature', ['announce.new']), context);
    expect(reply.content).toContain('Proactive posts');
    expect(reply.content).toContain('announce.new');
  });

  it('switches a feature off and back on again', async () => {
    const { context, guilds } = await started();
    await setupComponent.run(choose('setup:feature', ['events.list']), context);
    expect(await guilds.isFeatureEnabled(GUILD, 'events.list')).toBe(false);

    await setupComponent.run(choose('setup:feature', ['events.list']), context);
    expect(await guilds.isFeatureEnabled(GUILD, 'events.list')).toBe(true);
  });

  it('says the panels are finished when a manager presses done', async () => {
    const { context } = await started();
    const reply = await setupComponent.run(press('setup:step:done'), context);
    expect(reply.content).toContain('finished');
    expect(reply.components ?? []).toEqual([]);
  });

  it('offers a way back to every panel from the configuration menu', async () => {
    const { context } = await started();
    const reply = await configCommand.run(manager({ commandName: 'via config' }), context);
    expect(customIdsOf(reply)).toEqual(expect.arrayContaining([
      'setup:step:kind', 'setup:step:binding', 'setup:step:channels', 'setup:step:features',
    ]));
  });

  it('shows what the server has answered so far in the configuration menu', async () => {
    const { context, guilds } = await started();
    await guilds.setKind(GUILD, 'community');
    await guilds.setBinding(GUILD, { binding: 'all' });
    await guilds.bindChannel(GUILD, 'announcements', '700000000000000001');
    const reply = await configCommand.run(manager({ commandName: 'via config' }), context);
    expect(reply.content).toContain('community');
    expect(reply.content).toContain('every organization');
    expect(reply.content).toContain('<#700000000000000001>');
  });

  it('says that a server has not been set up rather than showing answers nobody gave', async () => {
    const { context } = await started();
    const reply = await configCommand.run(manager({ commandName: 'via config' }), context);
    expect(reply.content).toContain('has not been set up yet');
  });
});

describe('binding a server to one organization', () => {
  async function started() {
    const started = testContext();
    await started.guilds.createInstallation(GUILD, ROSA);
    return started;
  }

  it('binds it when VIA confirms the person is on that board', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    const reply = await setupComponent.run(choose('setup:bindrso', ['1']), context);

    const installation = await guilds.getInstallation(GUILD);
    expect(installation!.binding).toBe('rso');
    expect(installation!.rsoId).toBe(1);
    expect(reply.content).toContain('IEEE');
  });

  /**
   * The web platform has just confirmed that this person is on that board, and
   * reading the organization's members is board work, so the server writes
   * down who bound it and the daily role reconciliation reads the members as
   * that person.
   */
  it('writes down the board member VIA confirmed, so that the members can be read later', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    await setupComponent.run(choose('setup:bindrso', ['1']), context);
    expect((await guilds.getInstallation(GUILD))!.boundBy).toBe(ROSA);
  });

  it('binds it for a VIA global administrator, whatever board they sit on', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { isGlobalAdmin: true, memberships: [] });
    await setupComponent.run(choose('setup:bindrso', ['1']), context);
    expect((await guilds.getInstallation(GUILD))!.rsoId).toBe(1);
  });

  it('refuses a manager who has no VIA account, and offers the link command', async () => {
    const { context, guilds } = await started();
    const reply = await setupComponent.run(choose('setup:bindrso', ['1']), context);
    expect(reply.content).toBe(NOT_LINKED_TO_BIND_MESSAGE);
    expect(labelsOf(reply)).toContain('Link my account');
    expect((await guilds.getInstallation(GUILD))!.binding).toBeNull();
  });

  it('refuses a manager who is not on that board, and says who can bind it', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
    const reply = await setupComponent.run(choose('setup:bindrso', ['1']), context);
    expect(reply.content).toContain('board member of IEEE');
    expect(reply.content).toContain('global administrator');
    expect((await guilds.getInstallation(GUILD))!.binding).toBeNull();
  });

  it('binds nothing at all when VIA cannot be reached', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    via.failNextWith(Object.assign(new Error('no answer'), { name: 'ViaError' }));
    await setupComponent.run(choose('setup:bindrso', ['1']), context).catch(() => null);
    expect((await guilds.getInstallation(GUILD))!.binding).toBeNull();
  });

  it('binds an organization named on the command itself, with the same confirmation', async () => {
    const { context, guilds, via } = await started();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    const reply = await setupCommand.run(manager({ options: { rso: '1' } }), context);
    expect((await guilds.getInstallation(GUILD))!.rsoId).toBe(1);
    expect(reply.content).toContain('IEEE');
  });

  it('refuses an organization named on the command when VIA declines', async () => {
    const { context, guilds } = await started();
    const reply = await setupCommand.run(manager({ options: { rso: '1' } }), context);
    expect(reply.content).toBe(NOT_LINKED_TO_BIND_MESSAGE);
    expect((await guilds.getInstallation(GUILD))!.rsoId).toBeNull();
  });
});

describe('a feature that cannot work', () => {
  /**
   * The rule is tested against a feature written here rather than against one
   * from the registry, so that the shape of the rule stays readable in one
   * place even as the registry grows. The registry's own proactive features
   * are covered by the last test in this group.
   */
  const proactive: Feature = {
    ...featureById('events.list'),
    id: 'announce.new',
    description: 'Announce a new event in the channel bound to announcements.',
    summary: 'Announce a new event in the announcements channel.',
    category: 'proactive',
    defaultEnabled: false,
    channelPurposes: ['announcements'],
    requiredPermissions: ['SendMessages'],
    command: undefined,
  };

  const allowed = { channels: { announcements: '700000000000000001' }, permissions: ['SendMessages' as const] };

  it('is blocked by a purpose no channel is bound to', () => {
    expect(blockedReason(proactive, { ...allowed, channels: {} })).toContain('no channel is bound');
  });

  it('is blocked by a permission the bot was not given, named as Discord names it', () => {
    expect(blockedReason(proactive, { ...allowed, permissions: [] })).toContain('Send Messages');
  });

  it('is blocked by nothing at all when it has its channel and its permission', () => {
    expect(blockedReason(proactive, allowed)).toBeNull();
  });

  it('never blocks a feature that neither posts nor needs a permission', () => {
    const undemanding = features.filter(feature =>
      feature.channelPurposes.length === 0 && feature.requiredPermissions.length === 0);
    expect(undemanding.length).toBeGreaterThan(0);
    for (const feature of undemanding) {
      expect(blockedReason(feature, { channels: {}, permissions: [] })).toBeNull();
    }
  });

  it('blocks every proactive feature that posts in a server that bound nothing and granted nothing', () => {
    // The feedback request is the one proactive feature that posts nowhere in
    // the server and needs no permission there, so nothing in a server can
    // stop it working and there is nothing for the panel to say about it.
    for (const feature of features.filter(f => f.category === 'proactive' && f.id !== 'feedback.request')) {
      expect(blockedReason(feature, { channels: {}, permissions: [] })).not.toBeNull();
    }
    expect(blockedReason(featureById('feedback.request'), { channels: {}, permissions: [] })).toBeNull();
  });

  it('says on the panel why a blocked feature is blocked', () => {
    const panel = renderFeatureList({
      features: [proactive],
      enabled: { 'announce.new': false },
      channels: {},
      permissions: [],
      category: 'proactive',
    });
    expect(panel.content).toContain('no channel is bound');
    expect(panel.content).toContain('announce.new');
  });

  it('names the category the page is showing and says whether each feature on it is on', () => {
    const panel = renderFeatureList({
      features: [featureById('events.list'), proactive],
      enabled: { 'events.list': true, 'announce.new': false },
      channels: allowed.channels,
      permissions: allowed.permissions,
      category: 'command',
    });
    expect(panel.content).toContain('Commands');
    expect(panel.content).toContain('on: events.list');
    expect(panel.content).not.toContain('announce.new');
  });

  it('refuses to switch on a feature that cannot work, and says what is missing', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await toggleFeature(proactive, GUILD, context, { channels: {}, permissions: [] });
    expect(reply.content).toContain('no channel is bound');
  });

  it('still switches off a feature that cannot work, since switching off needs nothing', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    await guilds.setFeatureEnabled(GUILD, 'events.list', true);
    const reply = await toggleFeature(featureById('events.list'), GUILD, context, {
      channels: {},
      permissions: [],
    });
    expect(await guilds.isFeatureEnabled(GUILD, 'events.list')).toBe(false);
    expect(reply.content).toContain('off');
  });
});

describe('removing the bot from a server', () => {
  it('deletes every row for the server and says how many of each it deleted', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    await guilds.setKind(GUILD, 'community');
    await guilds.setBinding(GUILD, { binding: 'set' });
    await guilds.setFollowedRsos(GUILD, [1, 9]);
    await guilds.bindChannel(GUILD, 'announcements', '700000000000000001');
    await guilds.setFeatureEnabled(GUILD, 'events.list', false);

    const reply = await removeCommand.run(manager({ commandName: 'via remove' }), context);

    expect(await guilds.getInstallation(GUILD)).toBeNull();
    expect(reply.content).toContain('1 channel');
    expect(reply.content).toContain('2 organizations');
    expect(reply.content).toContain('1 feature');
  });

  it('says that nothing about the people who used the bot has been deleted', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await removeCommand.run(manager({ commandName: 'via remove' }), context);
    expect(reply.content).toContain('links');
  });

  it('says so plainly when there was nothing set up to remove', async () => {
    const { context } = testContext();
    const reply = await removeCommand.run(manager({ commandName: 'via remove' }), context);
    expect(reply.content).toContain('nothing');
  });

  it('says so plainly when the hook cleared nothing either, which is the deployed case', async () => {
    const { context } = testContext();
    const reply = await removeCommand.run(manager({ commandName: 'via remove' }), {
      ...context,
      removeGuildPresence: async () => ({ scheduledEvents: 0, unpinnedMessages: 0 }),
    });
    expect(reply.content).toContain('nothing');
  });

  it('refuses somebody without the Manage Server permission', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await removeCommand.run(
      manager({ commandName: 'via remove', memberPermissions: [] }),
      context,
    );
    expect(reply.content).toBe(NOT_A_MANAGER_MESSAGE);
    expect(await guilds.getInstallation(GUILD)).not.toBeNull();
  });

  /**
   * What the bot posted into the server goes before the rows that say where it
   * is, because those rows are what says where to look. The scheduled events
   * are deleted by the scheduled event mirror, which is what the entry point
   * gives this hook, and the removal says what it actually did.
   */
  it('calls the hook that clears what the bot posted, when there is one', async () => {
    const cleared: string[] = [];
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await removeCommand.run(manager({ commandName: 'via remove' }), {
      ...context,
      removeGuildPresence: async (guildId: string) => {
        cleared.push(guildId);
        return { scheduledEvents: 3, unpinnedMessages: 1 };
      },
    });
    expect(cleared).toEqual([GUILD]);
    expect(reply.content).toContain('3 scheduled events');
  });
});

/**
 * Discord refuses a message over two thousand characters and a menu over
 * twenty five options outright, and a panel that grows past either one is a
 * panel nobody can open. The registry is what grows, so the claim is made
 * against the whole registry rather than against a handful of features.
 */
describe('what Discord will carry', () => {
  const GUILD_STATE = {
    channels: {} as Record<string, string>,
    permissions: [] as never[],
  };

  function panels(): Reply[] {
    const enabled: Record<string, boolean> = {};
    return CATEGORY_ORDER.map(category => renderFeatureList({
      features,
      enabled,
      channels: GUILD_STATE.channels,
      permissions: GUILD_STATE.permissions,
      category,
    }));
  }

  it('keeps every page of the features panel inside the message Discord will carry', () => {
    for (const panel of panels()) {
      expect(panel.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    }
  });

  it('keeps every menu on every panel inside the options Discord will offer', () => {
    for (const panel of panels()) {
      for (const row of panel.components ?? []) {
        for (const component of row.components) {
          if (component.kind !== 'select') continue;
          expect((component.options ?? []).length).toBeLessThanOrEqual(MAX_SELECT_OPTIONS);
        }
      }
    }
  });

  it('keeps every panel of the whole walk inside both limits, with the full registry', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);

    const walked: Reply[] = [
      await setupCommand.run(manager(), context),
      await configCommand.run(manager({ commandName: 'via config' }), context),
      await setupComponent.run(press('setup:step:kind'), context),
      await setupComponent.run(press('setup:step:binding'), context),
      await setupComponent.run(press('setup:step:channels'), context),
      await setupComponent.run(press('setup:step:features'), context),
      await setupComponent.run(press('setup:step:timing'), context),
      ...await Promise.all(CATEGORY_ORDER.map(category =>
        setupComponent.run(choose('setup:category', [category]), context))),
    ];

    for (const panel of walked) {
      expect(panel.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect((panel.components ?? []).length).toBeLessThanOrEqual(MAX_ROWS);
      for (const row of panel.components ?? []) {
        for (const component of row.components) {
          if (component.kind !== 'select') continue;
          expect((component.options ?? []).length).toBeLessThanOrEqual(MAX_SELECT_OPTIONS);
        }
      }
    }
  });
});

describe('the language of every panel', () => {
  it('passes every string a manager reads through the language check', async () => {
    const { context, guilds, via } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    via.seedRso({ rsoId: 9, name: 'HKN' });

    const replies: Reply[] = [
      await setupCommand.run(manager(), context),
      await configCommand.run(manager({ commandName: 'via config' }), context),
      await setupComponent.run(choose('setup:kind', ['rso']), context),
      await setupComponent.run(choose('setup:binding', ['rso']), context),
      await setupComponent.run(choose('setup:binding', ['set']), context),
      await setupComponent.run(choose('setup:bindrso', ['1']), context),
      await setupComponent.run(press('setup:step:channels'), context),
      await setupComponent.run(choose('setup:purpose', ['announcements']), context),
      await setupComponent.run(choose('setup:channel:announcements', ['700000000000000001']), context),
      await setupComponent.run(press('setup:step:features'), context),
      await setupComponent.run(press('setup:step:done'), context),
      await setupCommand.run(manager({ memberPermissions: [] }), context),
      await removeCommand.run(manager({ commandName: 'via remove' }), context),
    ];

    const strings: string[] = [];
    for (const reply of replies) {
      strings.push(reply.content);
      for (const row of reply.components ?? []) {
        for (const component of row.components) {
          if (component.kind === 'button') strings.push(component.label);
          if (component.kind === 'select') {
            if (component.placeholder) strings.push(component.placeholder);
            for (const option of component.options ?? []) {
              strings.push(option.label);
              if (option.description) strings.push(option.description);
            }
          }
        }
      }
    }

    const dir = await mkdtemp(join(tmpdir(), 'via-bot-setup-'));
    try {
      const path = join(dir, 'strings.txt');
      await writeFile(path, strings.join('\n') + '\n');
      expect(findViolations([path])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
