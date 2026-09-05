import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let schema: typeof import('../../src/db/schema.ts');
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let deleteLocalData: typeof import('../../src/commands/unlink.ts').deleteLocalData;
let createRoleGrants: typeof import('../../src/roles/grants.ts').createRoleGrants;

/**
 * Unlinking deletes every subscription, preference, reminder, course, interest
 * mark and role grant the bot held for the account. That is a claim about six
 * tables, so it is tested against the real ones, including the claim that it
 * leaves everybody else alone.
 *
 * The role grants are the one of the six that is not only a row. A grant says
 * the bot gave somebody a Discord role because VIA listed them as a member, so
 * a link that has gone means the role has to be taken back in Discord before
 * the row that remembers it is deleted.
 */
describe('deleting what the bot holds for a Discord account', () => {
  const rosa = '204255221017214977';
  const other = '301422551071492041';
  const guild = '900000000000000001';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    schema = await import('../../src/db/schema.ts');
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ deleteLocalData } = await import('../../src/commands/unlink.ts'));
    ({ createRoleGrants } = await import('../../src/roles/grants.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  async function seed(discordUserId: string) {
    await db.insert(schema.subscriptions).values({ discordUserId, rsoId: 4 });
    await db.insert(schema.userPreferences).values({ discordUserId, digestDay: 0, digestHour: 9 });
    await db.insert(schema.reminders).values({ discordUserId, eventId: 41, remindAt: '2026-09-10 17:00:00' });
    await db.insert(schema.userCourses).values({ discordUserId, courseCode: 'ECE 391' });
    await db.insert(schema.interestMarks).values({ discordUserId, eventId: 41 });
  }

  it('deletes the rows in all six tables', async () => {
    await seed(rosa);
    await deleteLocalData(db, rosa);
    expect(await db.select().from(schema.subscriptions)).toEqual([]);
    expect(await db.select().from(schema.userPreferences)).toEqual([]);
    expect(await db.select().from(schema.reminders)).toEqual([]);
    expect(await db.select().from(schema.userCourses)).toEqual([]);
    expect(await db.select().from(schema.interestMarks)).toEqual([]);
  });

  it('leaves every other person untouched', async () => {
    await seed(rosa);
    await seed(other);
    await deleteLocalData(db, rosa);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    expect((await db.select().from(schema.userPreferences))[0]!.discordUserId).toBe(other);
    expect(await db.select().from(schema.reminders)).toHaveLength(1);
    expect(await db.select().from(schema.userCourses)).toHaveLength(1);
    expect(await db.select().from(schema.interestMarks)).toHaveLength(1);
  });

  it('does nothing and says nothing when there was nothing to delete', async () => {
    await expect(deleteLocalData(db, rosa)).resolves.toBeUndefined();
  });

  describe('the roles the bot gave the account', () => {
    async function seedGrant(discordUserId: string, guildId: string) {
      await db.insert(schema.guildInstallations).values({
        guildId, kind: 'rso', binding: 'rso', rsoId: 4, installedBy: rosa,
      });
      await createRoleGrants(db).record({
        guildId, discordUserId, roleId: `role-${guildId}`, membershipRole: 'member',
      });
    }

    it('takes the role back in every server that holds one, then forgets the grant', async () => {
      const taken: Array<{ guildId: string; discordUserId: string; role: unknown }> = [];
      await seedGrant(rosa, guild);
      await seedGrant(rosa, '900000000000000002');

      await deleteLocalData(db, rosa, {
        roles: {
          async apply(installation, discordUserId, role) {
            taken.push({ guildId: installation.guildId, discordUserId, role });
            return { granted: [], removed: [] };
          },
        },
      });

      expect(taken.map(one => one.guildId).sort())
        .toEqual([guild, '900000000000000002']);
      expect(taken.every(one => one.discordUserId === rosa && one.role === null)).toBe(true);
      expect(await db.select().from(schema.roleGrants)).toEqual([]);
    });

    it('leaves the grants of everybody else where they are', async () => {
      await seedGrant(rosa, guild);
      await createRoleGrants(db).record({
        guildId: guild, discordUserId: other, roleId: 'role-other', membershipRole: 'board',
      });

      await deleteLocalData(db, rosa, {
        roles: { async apply() { return { granted: [], removed: [] }; } },
      });

      const held = await db.select().from(schema.roleGrants);
      expect(held).toHaveLength(1);
      expect(held[0]!.discordUserId).toBe(other);
    });

    /**
     * A role the bot cannot take back is still a role the bot gave, and the
     * grant row is what remembers that. Deleting the row would strand the
     * role in the server for good, so a failure leaves both where they are.
     */
    it('leaves the grant where it is when the role could not be taken back', async () => {
      await seedGrant(rosa, guild);

      await expect(deleteLocalData(db, rosa, {
        roles: { async apply() { throw new Error('Discord did not answer'); } },
      })).rejects.toThrow('Discord did not answer');

      expect(await db.select().from(schema.roleGrants)).toHaveLength(1);
    });

    it('deletes the grants when no way of taking the roles back was given', async () => {
      await seedGrant(rosa, guild);
      await deleteLocalData(db, rosa);
      expect(await db.select().from(schema.roleGrants)).toEqual([]);
    });
  });
});
