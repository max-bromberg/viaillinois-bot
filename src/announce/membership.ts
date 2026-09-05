import type { MembershipRole, OutboxEntry } from '../via/client.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';
import type { NetIdDirectory } from '../roles/directory.ts';
import type { MembershipRoles } from '../roles/membership.ts';

/**
 * What the bot does when a membership changes on VIA.
 *
 * The entry names the person by NetID, the organization by identifier, and the
 * role they now hold, with a role of null meaning they are no longer a member.
 * Every server bound to that organization that has mapped its roles is brought
 * into step.
 *
 * The bot holds no NetID, so it can only act on a person whose Discord account
 * the web platform has already named for it, which is what the directory in
 * src/roles/directory.ts holds for an hour at a time. Somebody it cannot name
 * is skipped here and put right by the daily reconciliation, which reads the
 * organization's members and the bot's own grants. Skipping is the right
 * answer rather than a lookup: the bot has a NetID and no way to ask the web
 * platform which Discord account it belongs to, because links are resolved the
 * other way round.
 */

export interface MembershipHandlerOptions {
  guilds: GuildStore;
  roles: MembershipRoles;
  directory: NetIdDirectory;
}

/** The three fields a membership entry carries. */
export function readMembershipChange(entry: OutboxEntry): {
  netId: string;
  rsoId: number | null;
  role: MembershipRole | null;
} {
  const payload = entry.payload;
  const role = payload.role;
  return {
    netId: String(payload.net_id ?? ''),
    rsoId: payload.rso_id === undefined || payload.rso_id === null
      ? entry.rsoId
      : Number(payload.rso_id),
    // The web platform stores the roles capitalised, as it does everywhere
    // else, and the bot speaks of them in lower case.
    role: role === null || role === undefined || role === ''
      ? null
      : (String(role).toLowerCase() as MembershipRole),
  };
}

export function createMembershipHandlers(options: MembershipHandlerOptions): OutboxHandlers {
  const { guilds, roles, directory } = options;

  return {
    async 'membership.changed'(entry: OutboxEntry): Promise<void> {
      const change = readMembershipChange(entry);
      if (!change.netId || change.rsoId === null) {
        console.log(`outbox entry ${entry.outboxId} carries no membership to act on`);
        return;
      }

      const discordUserId = directory.discordUserFor(change.netId);
      if (!discordUserId) {
        // Nothing is guessed at. The daily reconciliation reads the members
        // from the web platform and puts this right.
        console.log(`outbox entry ${entry.outboxId} names a NetID the bot cannot put a Discord account to`);
        return;
      }

      for (const installation of await guilds.listGuildsFollowing(change.rsoId)) {
        // Roles are about the organization a server speaks for, so a community
        // server that follows several organizations gives out none of them.
        if (installation.binding !== 'rso' || installation.rsoId !== change.rsoId) continue;
        await roles.apply(installation, discordUserId, change.role);
      }
    },
  };
}
