import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let jobRuns: typeof import('../../src/db/schema.ts').jobRuns;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createJobRuns: typeof import('../../src/jobs/runs.ts').createJobRuns;

/**
 * When each scheduled job last ran.
 *
 * The record is what makes a missed hour run once on return rather than being
 * skipped or run twice, so it has to survive the process that wrote it. That
 * is a claim about the database, so it is tested against one.
 */
describe('Job_Runs', () => {
  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ jobRuns } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createJobRuns } = await import('../../src/jobs/runs.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  it('has nothing to say about a job that has never run', async () => {
    expect(await createJobRuns(db).lastRunAt('personal.digest')).toBe(null);
  });

  it('records when a job ran, in campus wall clock', async () => {
    const runs = createJobRuns(db);
    await runs.recordRun('personal.digest', '2026-09-06 18:00:00');
    expect(await runs.lastRunAt('personal.digest')).toBe('2026-09-06 18:00:00');
  });

  it('keeps one row per job, so a second run replaces the first', async () => {
    const runs = createJobRuns(db);
    await runs.recordRun('personal.digest', '2026-09-06 18:00:00');
    await runs.recordRun('personal.digest', '2026-09-06 19:00:00');

    const rows = await db.select().from(jobRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastRunAt).toBe('2026-09-06 19:00:00');
  });

  it('keeps the jobs apart from one another', async () => {
    const runs = createJobRuns(db);
    await runs.recordRun('personal.digest', '2026-09-06 18:00:00');
    await runs.recordRun('guild.digest', '2026-09-06 17:00:00');

    expect(await runs.lastRunAt('personal.digest')).toBe('2026-09-06 18:00:00');
    expect(await runs.lastRunAt('guild.digest')).toBe('2026-09-06 17:00:00');
  });
});
