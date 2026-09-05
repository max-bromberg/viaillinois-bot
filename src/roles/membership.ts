import { MAPPED_ROLES, type GuildInstallation, type GuildStore, type MappedRole } from '../guilds/store.ts';
import { isMissingAccess, type DiscordActions } from '../discord/adapter.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { MembershipRole } from '../via/client.ts';
import type { RoleGrants } from './grants.ts';

/**
 * Keeping a server's membership roles in step with VIA.
 *
 * A server bound to an organization maps VIA's member, editor and board roles
 * to Discord roles of its own, and the bot gives a person the role their
 * membership says they have and takes back the ones it gave them and they no
 * longer have.
 *
 * Two rules run through all of it.
 *
 * The bot never removes a role it did not grant. A server hands the same roles
 * out by hand, and taking one of those away because VIA does not list the
 * person would be the bot overruling the server about its own roles. So a role
 * is taken back only when Role_Grants says the bot is the one that gave it.
 *
 * A server that has taken the Manage Roles permission away has broken this
 * feature without meaning to. The bot switches it off, which is the honest
 * state, and tells the manager once, which is the same thing the proactive
 * features do when a channel goes.
 */

/** The feature a server switches on to have its roles kept in step. */
export const ROLES_FEATURE = 'roles.membership';

export const NO_MANAGE_ROLES_REASON = 'the bot does not have the Manage Roles permission here';

export interface MembershipRolesOptions {
  guilds: GuildStore;
  grants: RoleGrants;
  actions: Pick<DiscordActions, 'addRole' | 'removeRole' | 'permissionsIn'>;
  disable: FeatureDisabler;
}

/** What applying one membership did, which is what a test and the log read. */
export interface AppliedRoles {
  granted: string[];
  removed: string[];
}

export interface MembershipRoles {
  /**
   * Give one person the role their membership says they have in this server,
   * and take back the mapped roles the bot gave them that it no longer should.
   * A role of null means they are no longer a member of that organization.
   */
  apply(
    installation: GuildInstallation,
    discordUserId: string,
    role: MembershipRole | null,
  ): Promise<AppliedRoles>;
}

/**
 * Which mapped role a VIA membership role stands for. A global administrator
 * of VIA is not a membership of any organization, and the web platform's own
 * administrator role inside an organization is what a board is, so it is
 * mapped to the board role rather than to a role a server did not map.
 */
export function mappedRoleOf(role: MembershipRole | null): MappedRole | null {
  if (role === null) return null;
  if (role === 'admin') return 'board';
  return role;
}

export function createMembershipRoles(options: MembershipRolesOptions): MembershipRoles {
  const { guilds, grants, actions, disable } = options;

  return {
    async apply(installation, discordUserId, role) {
      const applied: AppliedRoles = { granted: [], removed: [] };
      const guildId = installation.guildId;

      if (!(await guilds.isFeatureEnabled(guildId, ROLES_FEATURE))) return applied;

      const mappings = await guilds.listRoleMappings(guildId);
      // A server that has mapped nothing has asked for nothing, and reading
      // Discord about it would be a call about a decision nobody made.
      if (Object.keys(mappings).length === 0) return applied;

      const permissions = await actions.permissionsIn(guildId);
      if (!permissions.includes('ManageRoles') && !permissions.includes('Administrator')) {
        await disable.disable(guildId, ROLES_FEATURE, NO_MANAGE_ROLES_REASON);
        return applied;
      }

      const wanted = mappedRoleOf(role);
      const wantedRoleId = wanted ? mappings[wanted] ?? null : null;

      if (wantedRoleId) {
        const held = await grants.listForMember(guildId, discordUserId);
        if (!held.some(grant => grant.roleId === wantedRoleId)) {
          const given = await actions.addRole(guildId, discordUserId, wantedRoleId);
          // Somebody who has left the server holds no roles, and writing down
          // a grant that was never made would let the bot take away a role it
          // never gave.
          if (given) {
            await grants.record({
              guildId, discordUserId, roleId: wantedRoleId, membershipRole: wanted!,
            });
            applied.granted.push(wantedRoleId);
          }
        }
      }

      // Everything else the bot gave this person here goes, and nothing it did
      // not give goes at all.
      const mine = await grants.listForMember(guildId, discordUserId);
      for (const grant of mine) {
        if (grant.roleId === wantedRoleId) continue;
        const stillMapped = MAPPED_ROLES.some(one => mappings[one] === grant.roleId);
        // A role the server has unmapped is left where it is, because the
        // server has stopped asking the bot to manage it.
        if (!stillMapped) continue;

        try {
          await actions.removeRole(guildId, discordUserId, grant.roleId);
        } catch (err) {
          if (!isMissingAccess(err)) throw err;
          await disable.disable(guildId, ROLES_FEATURE, NO_MANAGE_ROLES_REASON);
          return applied;
        }
        await grants.forget(grant);
        applied.removed.push(grant.roleId);
      }

      return applied;
    },
  };
}
