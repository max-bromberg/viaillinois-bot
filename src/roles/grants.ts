import { and, eq } from 'drizzle-orm';
import { roleGrants } from '../db/schema.ts';
import type { MappedRole } from '../guilds/store.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * The roles the bot itself gave out.
 *
 * Section 6.1 of the design says the bot never removes a role it did not
 * grant, and this table is the whole of that rule. A server hands the same
 * roles out by hand as well, to an alumnus, to somebody helping with one
 * event, or to a person whose membership VIA has not caught up with, and
 * taking one of those away because VIA does not list the person would be the
 * bot overruling the server about its own roles.
 *
 * So a row is written when the bot grants a role and deleted when it takes one
 * back, and a role with no row here is left alone for ever. Nothing is read
 * from Discord to decide it: the bot's own record is what it acts on, which
 * also means a role somebody removed by hand is not silently given back.
 */

export interface RoleGrant {
  guildId: string;
  discordUserId: string;
  roleId: string;
  /** Which VIA membership role the grant was made for. */
  membershipRole: MappedRole;
}

export interface RoleGrants {
  /** Write down that the bot gave somebody a role. Writing it twice is one row. */
  record(grant: RoleGrant): Promise<void>;
  /** Forget one grant, answering whether there was one to forget. */
  forget(grant: Omit<RoleGrant, 'membershipRole'>): Promise<boolean>;
  /** Every role the bot gave one person in one server. */
  listForMember(guildId: string, discordUserId: string): Promise<RoleGrant[]>;
  /** Every role the bot gave anybody in one server, which reconciliation reads back. */
  listForGuild(guildId: string): Promise<RoleGrant[]>;
  /** Forget every grant a server holds, and say how many that was. */
  removeGuild(guildId: string): Promise<number>;
}

function present(row: typeof roleGrants.$inferSelect): RoleGrant {
  return {
    guildId: row.guildId,
    discordUserId: row.discordUserId,
    roleId: row.roleId,
    membershipRole: row.membershipRole as MappedRole,
  };
}

export function createRoleGrants(db: BotDatabase): RoleGrants {
  return {
    async record(grant) {
      await db.insert(roleGrants)
        .values(grant)
        .onDuplicateKeyUpdate({ set: { membershipRole: grant.membershipRole } });
    },

    async forget(grant) {
      const held = await db.select().from(roleGrants).where(and(
        eq(roleGrants.guildId, grant.guildId),
        eq(roleGrants.discordUserId, grant.discordUserId),
        eq(roleGrants.roleId, grant.roleId),
      ));
      if (held.length === 0) return false;

      await db.delete(roleGrants).where(and(
        eq(roleGrants.guildId, grant.guildId),
        eq(roleGrants.discordUserId, grant.discordUserId),
        eq(roleGrants.roleId, grant.roleId),
      ));
      return true;
    },

    async listForMember(guildId, discordUserId) {
      const rows = await db.select().from(roleGrants).where(and(
        eq(roleGrants.guildId, guildId),
        eq(roleGrants.discordUserId, discordUserId),
      ));
      return rows.map(present);
    },

    async listForGuild(guildId) {
      const rows = await db.select().from(roleGrants).where(eq(roleGrants.guildId, guildId));
      return rows.map(present);
    },

    async removeGuild(guildId) {
      const rows = await db.select().from(roleGrants).where(eq(roleGrants.guildId, guildId));
      await db.delete(roleGrants).where(eq(roleGrants.guildId, guildId));
      return rows.length;
    },
  };
}
