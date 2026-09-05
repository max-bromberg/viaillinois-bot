import type { RoleGrant, RoleGrants } from '../../src/roles/grants.ts';

/**
 * The roles the bot granted, in memory.
 *
 * What the table guarantees is tested against a real database in
 * tests/db/roleGrants.db.test.ts. What the role handling needs from it here is
 * the one behaviour the whole table exists for: a role the bot granted can be
 * read back, and a role nobody wrote down is not there to be found.
 */
export function memoryRoleGrants(): RoleGrants {
  const rows: RoleGrant[] = [];
  const same = (left: RoleGrant, right: { guildId: string; discordUserId: string; roleId: string }) =>
    left.guildId === right.guildId
    && left.discordUserId === right.discordUserId
    && left.roleId === right.roleId;

  return {
    async record(grant: RoleGrant) {
      if (!rows.some(row => same(row, grant))) rows.push({ ...grant });
    },

    async forget(grant) {
      const kept = rows.filter(row => !same(row, grant));
      const removed = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return removed > 0;
    },

    async listForMember(guildId: string, discordUserId: string) {
      return rows
        .filter(row => row.guildId === guildId && row.discordUserId === discordUserId)
        .map(row => ({ ...row }));
    },

    async listForGuild(guildId: string) {
      return rows.filter(row => row.guildId === guildId).map(row => ({ ...row }));
    },

    async removeGuild(guildId: string) {
      const kept = rows.filter(row => row.guildId !== guildId);
      const removed = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return removed;
    },
  };
}
