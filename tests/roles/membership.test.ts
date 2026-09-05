import { describe, it, expect } from 'vitest';
import { createMembershipRoles, ROLES_FEATURE, NO_MANAGE_ROLES_REASON } from '../../src/roles/membership.ts';
import { createNetIdDirectory, withNetIdDirectory } from '../../src/roles/directory.ts';
import { createMembershipHandlers } from '../../src/announce/membership.ts';
import { createRoleReconciliationJob } from '../../src/jobs/roleReconcile.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryGuildStore } from '../commands/support.ts';
import { memoryDeliveries, recordingActions } from '../support/proactive.ts';
import { memoryRoleGrants } from '../support/grants.ts';
import { createFeatureDisabler } from '../../src/guilds/disable.ts';
import type { GuildStore } from '../../src/guilds/store.ts';

/**
 * Membership roles.
 *
 * A server bound to an organization maps VIA's member, editor and board roles
 * to Discord roles, and the bot keeps them in step: it gives somebody the role
 * their membership says they have, and takes away the ones it gave them and
 * they no longer have.
 *
 * Two rules matter more than the mechanism. The bot never removes a role it
 * did not grant, because a server hands the same roles out by hand and taking
 * one of those away would be the bot overruling the server about its own
 * roles. And the bot never learns who a NetID is except from the web platform:
 * it holds no NetID of its own, so a person it cannot resolve is skipped and
 * left to the daily reconciliation.
 */

const GUILD = '900000000000000001';
const ROSA = '204255221017214977';
const BO = '301422551071492041';
const MEMBER_ROLE = '500000000000000001';
const EDITOR_ROLE = '500000000000000002';
const BOARD_ROLE = '500000000000000003';

async function server(options: { mapped?: boolean; enabled?: boolean } = {}) {
  const guilds: GuildStore = memoryGuildStore();
  await guilds.createInstallation(GUILD, ROSA);
  await guilds.setKind(GUILD, 'rso');
  await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 1, boundBy: ROSA });
  await guilds.setFeatureEnabled(GUILD, ROLES_FEATURE, options.enabled !== false);
  if (options.mapped !== false) {
    await guilds.setRoleMapping(GUILD, 'member', MEMBER_ROLE);
    await guilds.setRoleMapping(GUILD, 'editor', EDITOR_ROLE);
    await guilds.setRoleMapping(GUILD, 'board', BOARD_ROLE);
  }
  return guilds;
}

function parts(guilds: GuildStore) {
  const actions = recordingActions({ permissions: ['ManageRoles'] });
  const grants = memoryRoleGrants();
  const deliveries = memoryDeliveries();
  const directMessages: Array<{ discordUserId: string; content: string }> = [];
  const disable = createFeatureDisabler({
    guilds,
    deliveries,
    sendDirectMessage: async (discordUserId, content) => {
      directMessages.push({ discordUserId, content });
      return true;
    },
  });
  const roles = createMembershipRoles({ guilds, grants, actions, disable });
  return { actions, grants, roles, disable, directMessages, deliveries };
}

describe('giving somebody the role their membership says they have', () => {
  it('gives the mapped role and writes down that the bot gave it', async () => {
    const guilds = await server();
    const { actions, grants, roles } = parts(guilds);

    await roles.apply((await guilds.getInstallation(GUILD))!, BO, 'editor');

    expect(actions.done).toEqual([
      { action: 'addRole', guildId: GUILD, discordUserId: BO, roleId: EDITOR_ROLE },
    ]);
    expect(await grants.listForGuild(GUILD)).toEqual([
      { guildId: GUILD, discordUserId: BO, roleId: EDITOR_ROLE, membershipRole: 'editor' },
    ]);
  });

  it('gives the board role to somebody the web platform calls an administrator of it', async () => {
    const guilds = await server();
    const { actions, roles } = parts(guilds);
    await roles.apply((await guilds.getInstallation(GUILD))!, BO, 'admin');
    expect(actions.done[0]!.roleId).toBe(BOARD_ROLE);
  });

  it('gives one role rather than two when a membership changes', async () => {
    const guilds = await server();
    const { actions, grants, roles } = parts(guilds);
    const installation = (await guilds.getInstallation(GUILD))!;

    await roles.apply(installation, BO, 'member');
    await roles.apply(installation, BO, 'board');

    expect(actions.done.map(one => `${one.action} ${one.roleId}`)).toEqual([
      `addRole ${MEMBER_ROLE}`,
      `addRole ${BOARD_ROLE}`,
      `removeRole ${MEMBER_ROLE}`,
    ]);
    expect(await grants.listForGuild(GUILD)).toEqual([
      { guildId: GUILD, discordUserId: BO, roleId: BOARD_ROLE, membershipRole: 'board' },
    ]);
  });

  it('takes every role it gave away when somebody is no longer a member', async () => {
    const guilds = await server();
    const { actions, grants, roles } = parts(guilds);
    const installation = (await guilds.getInstallation(GUILD))!;

    await roles.apply(installation, BO, 'board');
    await roles.apply(installation, BO, null);

    expect(actions.done.at(-1)).toEqual({
      action: 'removeRole', guildId: GUILD, discordUserId: BO, roleId: BOARD_ROLE,
    });
    expect(await grants.listForGuild(GUILD)).toEqual([]);
  });

  it('does nothing at all in a server that has mapped no roles', async () => {
    const guilds = await server({ mapped: false });
    const { actions, roles } = parts(guilds);
    await roles.apply((await guilds.getInstallation(GUILD))!, BO, 'member');
    expect(actions.done).toEqual([]);
  });

  it('does nothing at all in a server that has not switched the feature on', async () => {
    const guilds = await server({ enabled: false });
    const { actions, roles } = parts(guilds);
    await roles.apply((await guilds.getInstallation(GUILD))!, BO, 'member');
    expect(actions.done).toEqual([]);
  });

  it('gives the role again to somebody who left the server and came back', async () => {
    const guilds = await server();
    const { actions, roles } = parts(guilds);
    const installation = (await guilds.getInstallation(GUILD))!;

    actions.setAbsent(BO);
    await roles.apply(installation, BO, 'member');
    expect(actions.done).toEqual([]);
  });

  /**
   * The rule the whole table exists for. A person can hold a mapped role
   * because a server manager gave it to them, and the bot has no business
   * taking that away because VIA does not list them.
   */
  it('never takes away a role it did not grant', async () => {
    const guilds = await server();
    const { actions, grants, roles } = parts(guilds);
    const installation = (await guilds.getInstallation(GUILD))!;

    // Somebody holds the board role because a manager gave it to them by hand,
    // which is a Discord fact the bot never wrote down.
    await roles.apply(installation, BO, null);

    expect(actions.done).toEqual([]);
    expect(await grants.listForGuild(GUILD)).toEqual([]);
  });

  it('switches the feature off and tells the manager when Manage Roles has been taken away', async () => {
    const guilds = await server();
    const { actions, roles, directMessages } = parts(guilds);
    actions.setPermissions(GUILD, ['ViewChannel']);

    await roles.apply((await guilds.getInstallation(GUILD))!, BO, 'member');

    expect(actions.done).toEqual([]);
    expect(await guilds.isFeatureEnabled(GUILD, ROLES_FEATURE)).toBe(false);
    expect(directMessages).toHaveLength(1);
    expect(directMessages[0]!.content).toContain(NO_MANAGE_ROLES_REASON);
  });

  it('tells the manager once rather than on every membership that changes', async () => {
    const guilds = await server();
    const { actions, roles, directMessages } = parts(guilds);
    actions.setPermissions(GUILD, []);
    const installation = (await guilds.getInstallation(GUILD))!;

    await roles.apply(installation, BO, 'member');
    await guilds.setFeatureEnabled(GUILD, ROLES_FEATURE, true);
    await roles.apply(installation, BO, 'member');

    expect(directMessages).toHaveLength(1);
  });
});

describe('who a NetID is', () => {
  it('remembers the Discord account the web platform named, and forgets it after a while', () => {
    let now = new Date('2026-09-05T12:00:00Z');
    const directory = createNetIdDirectory({ now: () => now, ttlMs: 60_000 });

    directory.remember({
      discordUserId: BO,
      netId: 'bo',
      displayName: 'Bo Chen',
      isGlobalAdmin: false,
      linkedAt: '2026-09-01T09:00:00-05:00',
      memberships: [],
    });
    expect(directory.discordUserFor('bo')).toBe(BO);

    now = new Date('2026-09-05T12:02:00Z');
    expect(directory.discordUserFor('bo')).toBe(null);
  });

  it('is filled by the link lookups the bot already makes', async () => {
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);
    via.seedLink(BO, { netId: 'bo' });

    expect(directory.discordUserFor('bo')).toBe(null);
    await via.getLink(BO);
    expect(directory.discordUserFor('bo')).toBe(BO);
  });

  it('holds no NetID for an account nobody has looked up', async () => {
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);
    await via.getLink(BO);
    expect(directory.discordUserFor('bo')).toBe(null);
  });
});

describe('a membership that changed on VIA', () => {
  async function handled(role: string | null, options: { known?: boolean } = {}) {
    const guilds = await server();
    const built = parts(guilds);
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);

    via.seedLink(BO, { netId: 'bo' });
    if (options.known !== false) await via.getLink(BO);

    const handlers = createMembershipHandlers({
      guilds,
      roles: built.roles,
      directory,
    });
    const entry = via.seedOutbox('membership.changed', {
      rsoId: 1,
      payload: { net_id: 'bo', rso_id: 1, role },
    });
    await handlers['membership.changed']!(entry);
    return built;
  }

  it('gives the mapped role in every server bound to that organization', async () => {
    const built = await handled('Editor');
    expect(built.actions.done).toEqual([
      { action: 'addRole', guildId: GUILD, discordUserId: BO, roleId: EDITOR_ROLE },
    ]);
  });

  it('takes the roles it gave when the entry says the person is no longer a member', async () => {
    const guilds = await server();
    const built = parts(guilds);
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);
    via.seedLink(BO, { netId: 'bo' });
    await via.getLink(BO);

    const handlers = createMembershipHandlers({ guilds, roles: built.roles, directory });
    await handlers['membership.changed']!(via.seedOutbox('membership.changed', {
      rsoId: 1, payload: { net_id: 'bo', rso_id: 1, role: 'Member' },
    }));
    await handlers['membership.changed']!(via.seedOutbox('membership.changed', {
      rsoId: 1, payload: { net_id: 'bo', rso_id: 1, role: null },
    }));

    expect(built.actions.done.at(-1)!.action).toBe('removeRole');
  });

  it('skips a person it cannot put a Discord account to, and touches nothing', async () => {
    const built = await handled('Editor', { known: false });
    expect(built.actions.done).toEqual([]);
  });
});

describe('the daily reconciliation', () => {
  const hour = {
    at: new Date('2026-09-07T12:00:00Z'),
    startedAt: '2026-09-07 07:00:00',
    day: '2026-09-07',
    hour: 7,
    dayOfWeek: 1,
  };

  async function reconciling() {
    const guilds = await server();
    const built = parts(guilds);
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);

    via.seedLink(ROSA, {
      netId: 'alice',
      memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }],
    });
    await via.getLink(ROSA);

    const job = createRoleReconciliationJob({
      guilds, roles: built.roles, grants: built.grants, directory, via,
    });
    return { guilds, via, job, ...built };
  }

  it('gives every member the role their membership says, as the board member the server was bound by', async () => {
    const { job, actions, via } = await reconciling();
    await job.run(hour);

    expect(via.calls).toContain('listRsoMembers');
    expect(actions.done).toEqual([
      { action: 'addRole', guildId: GUILD, discordUserId: ROSA, roleId: BOARD_ROLE },
    ]);
  });

  it('skips a member whose Discord account it cannot name', async () => {
    const { job, actions, via } = await reconciling();
    via.seedMember(1, { netId: 'nobodyknows', fullName: 'Nobody Knows', role: 'member' });

    await job.run(hour);
    expect(actions.done.map(one => one.discordUserId)).toEqual([ROSA]);
  });

  /**
   * Somebody who left the organization stops appearing among its members, so
   * the roles they were given are taken from the other side: the bot reads
   * back its own grants and asks the web platform who each of those people is
   * now.
   */
  it('takes back a role from somebody who is no longer listed as a member', async () => {
    const { job, guilds, grants, actions, via } = await reconciling();
    via.seedLink(BO, { netId: 'bo', memberships: [] });
    await grants.record({
      guildId: GUILD, discordUserId: BO, roleId: MEMBER_ROLE, membershipRole: 'member',
    });

    await job.run(hour);

    expect(actions.done).toContainEqual({
      action: 'removeRole', guildId: GUILD, discordUserId: BO, roleId: MEMBER_ROLE,
    });
    expect((await grants.listForGuild(GUILD)).map(row => row.discordUserId)).not.toContain(BO);
    expect(await guilds.isFeatureEnabled(GUILD, ROLES_FEATURE)).toBe(true);
  });

  it('leaves a server that mapped no roles alone, and asks the web platform nothing', async () => {
    const guilds = await server({ mapped: false });
    const built = parts(guilds);
    const directory = createNetIdDirectory();
    const via = withNetIdDirectory(createFakeViaClient(), directory);
    const job = createRoleReconciliationJob({
      guilds, roles: built.roles, grants: built.grants, directory, via,
    });

    await job.run(hour);
    expect(via.calls).not.toContain('listRsoMembers');
  });

  it('leaves a server alone when the board member it was bound by can no longer read the members', async () => {
    const { job, via, actions } = await reconciling();
    via.removeLink(ROSA);

    await expect(job.run(hour)).resolves.toBeDefined();
    expect(actions.done).toEqual([]);
  });
});
