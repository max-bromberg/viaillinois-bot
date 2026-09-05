import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let interestMarks: typeof import('../../src/db/schema.ts').interestMarks;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createInterestMarks: typeof import('../../src/feed/interestMarks.ts').createInterestMarks;

/**
 * Interest_Marks is who the feedback request goes to.
 *
 * The web platform holds interest by NetID, and the bot must never hold a
 * NetID, so the bot keeps its own record of which Discord account marked
 * interest in which event. Everything the morning after job asks of that
 * record is a question the database answers, so it is tested against a real
 * one: a mark that is written twice is one mark, a mark that is withdrawn
 * leaves nothing behind, and the rows of a person who unlinks go with them.
 */
describe('Interest_Marks', () => {
  const ADA = '204255221017214977';
  const GRACE = '204255221017214978';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ interestMarks } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createInterestMarks } = await import('../../src/feed/interestMarks.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  function marks() {
    return createInterestMarks(db, { now: () => new Date('2026-09-07T18:00:00-05:00') });
  }

  it('writes one row for one person and one event, and says that it is new', async () => {
    expect(await marks().mark(10, ADA)).toBe(true);
    const rows = await db.select().from(interestMarks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(10);
    expect(rows[0]!.discordUserId).toBe(ADA);
    expect(rows[0]!.markedAt).toBe('2026-09-07 18:00:00');
  });

  it('takes the same mark twice as one mark, and says that the second was not new', async () => {
    await marks().mark(10, ADA);
    expect(await marks().mark(10, ADA)).toBe(false);
    expect(await db.select().from(interestMarks)).toHaveLength(1);
  });

  it('leaves nothing behind when interest is withdrawn', async () => {
    await marks().mark(10, ADA);
    expect(await marks().unmark(10, ADA)).toBe(true);
    expect(await db.select().from(interestMarks)).toHaveLength(0);
    // Withdrawing interest nobody left is not a failure, it is nothing to do.
    expect(await marks().unmark(10, ADA)).toBe(false);
  });

  it('lists the people who marked interest in one event, and nobody else', async () => {
    await marks().mark(10, ADA);
    await marks().mark(10, GRACE);
    await marks().mark(11, GRACE);
    expect(await marks().listPeople(10)).toEqual([ADA, GRACE]);
    expect(await marks().listPeople(11)).toEqual([GRACE]);
    expect(await marks().listPeople(12)).toEqual([]);
  });

  it('lists every event anybody marked interest in, once each', async () => {
    await marks().mark(11, ADA);
    await marks().mark(10, ADA);
    await marks().mark(10, GRACE);
    expect(await marks().listEvents()).toEqual([10, 11]);
  });

  it('clears every mark on one event once the feedback for it has been asked for', async () => {
    await marks().mark(10, ADA);
    await marks().mark(10, GRACE);
    await marks().mark(11, GRACE);
    expect(await marks().clearEvent(10)).toBe(2);
    expect(await marks().listEvents()).toEqual([11]);
  });

  it('takes every mark a person left with them when they unlink', async () => {
    await marks().mark(10, ADA);
    await marks().mark(11, ADA);
    await marks().mark(10, GRACE);
    expect(await marks().removeForUser(ADA)).toBe(2);
    expect(await marks().listPeople(10)).toEqual([GRACE]);
    expect(await marks().listEvents()).toEqual([10]);
  });
});
