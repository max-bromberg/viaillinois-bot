import { describe, it, expect } from 'vitest';
import {
  rolesCommand, rolesComponent, ROLES_BUTTON, NOT_A_MANAGER_MESSAGE, GUILD_ONLY_MESSAGE,
  NOT_BOUND_MESSAGE, NO_MANAGE_ROLES_MESSAGE,
} from '../../src/commands/roles.ts';
import { ROLES_FEATURE } from '../../src/roles/membership.ts';
import type { Interaction, Reply, ReplySelect } from '../../src/discord/adapter.ts';
import { interaction, testContext } from './support.ts';

/**
 * Mapping VIA's membership roles to a server's own roles.
 *
 * This is a server manager's decision rather than a board's, because it is
 * about the server's roles, so it is behind the Manage Server permission like
 * the rest of setup. What it needs of the bot is the Manage Roles permission,
 * and the panel says so plainly rather than mapping a role that could never be
 * given.
 */

const GUILD = '900000000000000001';
const ROSA = '204255221017214977';
const MEMBER_ROLE = '500000000000000001';

function manager(overrides: Partial<Interaction> = {}): Interaction {
  return interaction({
    commandName: 'via roles',
    guildId: GUILD,
    userId: ROSA,
    memberPermissions: ['ManageGuild'],
    applicationPermissions: ['ViewChannel', 'SendMessages', 'ManageRoles'],
    ...overrides,
  });
}

const choose = (customId: string, values: string[], overrides: Partial<Interaction> = {}) =>
  manager({ kind: 'select', commandName: null, customId, values, ...overrides });

async function bound() {
  const started = testContext();
  await started.guilds.createInstallation(GUILD, ROSA);
  await started.guilds.setKind(GUILD, 'rso');
  await started.guilds.setBinding(GUILD, { binding: 'rso', rsoId: 1, boundBy: ROSA });
  return started;
}

function selectIn(reply: Reply, customId: string): ReplySelect | undefined {
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'select' && component.customId === customId) return component;
    }
  }
  return undefined;
}

describe('who may map the roles', () => {
  it('answers only the person who ran it', () => {
    expect(rolesCommand.ephemeral).toBe(true);
  });

  it('refuses somebody without the Manage Server permission', async () => {
    const { context } = await bound();
    const reply = await rolesCommand.run(manager({ memberPermissions: [] }), context);
    expect(reply.content).toBe(NOT_A_MANAGER_MESSAGE);
  });

  it('says it belongs in a server when it is run outside one', async () => {
    const { context } = await bound();
    const reply = await rolesCommand.run(
      manager({ guildId: null, context: 'botDm', memberPermissions: [] }),
      context,
    );
    expect(reply.content).toBe(GUILD_ONLY_MESSAGE);
  });

  it('says a server has to be bound to an organization first', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation(GUILD, ROSA);
    const reply = await rolesCommand.run(manager(), context);
    expect(reply.content).toBe(NOT_BOUND_MESSAGE);
  });

  it('says the bot needs the Manage Roles permission, and maps nothing without it', async () => {
    const { context } = await bound();
    const reply = await rolesCommand.run(
      manager({ applicationPermissions: ['ViewChannel', 'SendMessages'] }),
      context,
    );
    expect(reply.content).toContain(NO_MANAGE_ROLES_MESSAGE);
  });
});

describe('the panel', () => {
  it('offers a menu of the server own roles for each of the three VIA roles', async () => {
    const { context } = await bound();
    const reply = await rolesCommand.run(manager(), context);

    for (const role of ['member', 'editor', 'board'] as const) {
      const select = selectIn(reply, ROLES_BUTTON.map(role))!;
      expect(select.selectKind).toBe('role');
    }
  });

  it('says which Discord role each VIA role is mapped to now', async () => {
    const { context, guilds } = await bound();
    await guilds.setRoleMapping(GUILD, 'member', MEMBER_ROLE);
    const reply = await rolesCommand.run(manager(), context);
    expect(reply.content).toContain(`<@&${MEMBER_ROLE}>`);
    expect(reply.content).toContain('no Discord role');
  });

  it('maps the role a manager chose, and says so', async () => {
    const { context, guilds } = await bound();
    const reply = await rolesComponent.run(choose(ROLES_BUTTON.map('editor'), [MEMBER_ROLE]), context);
    expect(await guilds.listRoleMappings(GUILD)).toEqual({ editor: MEMBER_ROLE });
    expect(reply.content).toContain(`<@&${MEMBER_ROLE}>`);
  });

  /**
   * Switching the feature on is what a manager came here to do, so the panel
   * does it rather than sending them to another panel to find a toggle.
   */
  it('switches the feature on with the first mapping, since that is what mapping means', async () => {
    const { context, guilds } = await bound();
    expect(await guilds.isFeatureEnabled(GUILD, ROLES_FEATURE)).toBe(false);
    await rolesComponent.run(choose(ROLES_BUTTON.map('member'), [MEMBER_ROLE]), context);
    expect(await guilds.isFeatureEnabled(GUILD, ROLES_FEATURE)).toBe(true);
  });

  it('stops mapping a role, and leaves every role already given where it is', async () => {
    const { context, guilds } = await bound();
    await guilds.setRoleMapping(GUILD, 'member', MEMBER_ROLE);
    const reply = await rolesComponent.run(manager({
      kind: 'button', commandName: null, customId: ROLES_BUTTON.unmap('member'),
    }), context);

    expect(await guilds.listRoleMappings(GUILD)).toEqual({});
    expect(reply.content).toContain('already');
  });

  it('refuses a menu from somebody without the Manage Server permission', async () => {
    const { context, guilds } = await bound();
    const reply = await rolesComponent.run(
      choose(ROLES_BUTTON.map('member'), [MEMBER_ROLE], { memberPermissions: [] }),
      context,
    );
    expect(reply.content).toBe(NOT_A_MANAGER_MESSAGE);
    expect(await guilds.listRoleMappings(GUILD)).toEqual({});
  });
});
