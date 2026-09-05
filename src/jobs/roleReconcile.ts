import { ViaError, type MembershipRole, type ViaClient } from '../via/client.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { NetIdDirectory } from '../roles/directory.ts';
import type { RoleGrants } from '../roles/grants.ts';
import type { MembershipRoles } from '../roles/membership.ts';
import type { JobHour } from './scheduler.ts';

/**
 * The daily reconciliation of membership roles.
 *
 * The outbox keeps a server in step as memberships change, and it can only act
 * on a person whose Discord account the bot can name at that moment. This job
 * is what puts the rest right: once a day it reads the organization's members
 * from the web platform and gives each of them the role their membership says
 * they have, and then reads back the roles the bot itself gave in that server
 * and asks the web platform who each of those people is now, so that somebody
 * who has left the organization has the roles the bot gave them taken back.
 *
 * Two things it does not do. It reads nothing from Discord about who is in the
 * server, because section 10 of the design says role reconciliation reads
 * membership from VIA rather than from Discord. And it never removes a role
 * the bot did not grant, which is the rule Role_Grants exists for.
 *
 * The members endpoint is board work on the web platform, and the bot has no
 * identity of its own on VIA, so the members are read as the board member the
 * server was bound by. A server whose binder is no longer on that board is
 * refused, which is left alone with a line in the log: the server can put it
 * right by binding again, and a bot that switched the feature off over a
 * refusal it cannot explain would be worse than one that waits.
 */

export interface RoleReconciliationOptions {
  guilds: GuildStore;
  roles: MembershipRoles;
  grants: RoleGrants;
  directory: NetIdDirectory;
  via: Pick<ViaClient, 'listRsoMembers' | 'getLink'>;
}

/** What one pass did, which is what the log reads. */
export interface ReconciliationReport {
  /** How many servers were looked at. */
  servers: number;
  /** How many people were given or had taken the role their membership says. */
  people: number;
  /** How many members could not be put to a Discord account and were left. */
  unresolved: number;
}

export interface RoleReconciliationJob {
  run(hour: JobHour): Promise<ReconciliationReport>;
}

export function createRoleReconciliationJob(
  options: RoleReconciliationOptions,
): RoleReconciliationJob {
  const { guilds, roles, grants, directory, via } = options;

  /** The role somebody holds in one organization, from the link the web platform answers. */
  async function roleIn(discordUserId: string, rsoId: number): Promise<MembershipRole | null> {
    const link = await via.getLink(discordUserId);
    if (!link) return null;
    return link.memberships.find(membership => membership.rsoId === rsoId)?.role ?? null;
  }

  async function reconcile(
    installation: GuildInstallation,
    report: ReconciliationReport,
  ): Promise<void> {
    const rsoId = installation.rsoId;
    if (installation.binding !== 'rso' || rsoId === null) return;

    const mappings = await guilds.listRoleMappings(installation.guildId);
    if (Object.keys(mappings).length === 0) return;

    const boundBy = installation.boundBy;
    if (!boundBy) {
      console.log(
        `server ${installation.guildId} has no board member recorded to read its members as, `
        + 'so its roles were not reconciled. Binding the server again records one.',
      );
      return;
    }

    let members;
    try {
      members = await via.listRsoMembers(rsoId, boundBy);
    } catch (err) {
      const code = err instanceof ViaError ? err.code : 'unreachable';
      console.error(
        `reading the members of organization ${rsoId} for server ${installation.guildId} was refused with ${code}`,
      );
      return;
    }

    report.servers += 1;
    const handled = new Set<string>();

    for (const member of members) {
      const discordUserId = directory.discordUserFor(member.netId);
      if (!discordUserId) {
        // The bot holds no NetID and has no way to ask which Discord account
        // one belongs to, so a person nobody has looked up is left as they
        // are until they use the bot and the directory learns who they are.
        report.unresolved += 1;
        continue;
      }
      handled.add(discordUserId);
      await roles.apply(installation, discordUserId, member.role);
      report.people += 1;
    }

    // The other direction: everybody the bot gave a role to here who is not
    // among the members it just read. Their Discord account is what the bot
    // holds, so their membership is read from their own link.
    for (const grant of await grants.listForGuild(installation.guildId)) {
      if (handled.has(grant.discordUserId)) continue;
      const role = await roleIn(grant.discordUserId, rsoId);
      await roles.apply(installation, grant.discordUserId, role);
      report.people += 1;
      handled.add(grant.discordUserId);
    }
  }

  return {
    async run(_hour: JobHour): Promise<ReconciliationReport> {
      const report: ReconciliationReport = { servers: 0, people: 0, unresolved: 0 };

      for (const installation of await guilds.listInstallations()) {
        try {
          await reconcile(installation, report);
        } catch (err) {
          // One server that fails must not stop the rest, and the next day's
          // pass tries it again.
          console.error(
            `reconciling the roles of server ${installation.guildId} failed:`,
            (err as Error).message,
          );
        }
      }

      return report;
    },
  };
}
