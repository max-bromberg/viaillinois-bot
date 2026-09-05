import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let schema: typeof import('../../src/db/schema.ts');
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let deleteLocalData: typeof import('../../src/commands/unlink.ts').deleteLocalData;

/**
 * Unlinking deletes every subscription, preference, reminder, course and
 * interest mark the bot held for the account. That is a claim about five
 * tables, so it is tested against the real ones, including the claim that it
 * leaves everybody else alone.
 */
describe('deleting what the bot holds for a Discord account', () => {
  const rosa = '204255221017214977';
  const other = '301422551071492041';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    schema = await import('../../src/db/schema.ts');
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ deleteLocalData } = await import('../../src/commands/unlink.ts'));
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

  it('deletes the rows in all five tables', async () => {
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
});
