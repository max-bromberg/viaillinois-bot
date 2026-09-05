import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let rateWindows: typeof import('../../src/db/schema.ts').rateWindows;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createRateWindows: typeof import('../../src/ratelimit/windows.ts').createRateWindows;
let userSubject: typeof import('../../src/ratelimit/windows.ts').userSubject;
let guildSubject: typeof import('../../src/ratelimit/windows.ts').guildSubject;

/**
 * The rate windows are a claim about arithmetic over rows: what the count in
 * the last hour is, when a bucket leaves the window, and what the sweep
 * removes. The database is what holds that, so it is tested against a real
 * one rather than against a map in memory.
 */
describe('Rate_Windows', () => {
  let clock = new Date('2026-09-05T14:30:20Z');
  const now = () => clock;

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ rateWindows } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createRateWindows, userSubject, guildSubject } = await import('../../src/ratelimit/windows.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
    clock = new Date('2026-09-05T14:30:20Z');
  });

  afterAll(async () => { await pool.end(); });

  const windows = () => createRateWindows({
    db,
    now,
    limits: { unlinkedPerHour: 3, linkedPerHour: 5, guildPerHour: 8 },
  });

  // Written out rather than built with userSubject, because the module is
  // imported inside beforeAll and this line runs before that.
  const rosa = 'user:204255221017214977';

  it('allows commands up to the limit for the tier and refuses the one past it', async () => {
    const limiter = windows();
    for (let i = 0; i < 3; i++) {
      const decision = await limiter.consume(rosa, 'unlinked');
      expect(decision.allowed).toBe(true);
    }
    const refused = await limiter.consume(rosa, 'unlinked');
    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe(3);
    expect(refused.used).toBe(3);
  });

  it('gives a linked person the wider limit and a server a wider one still', async () => {
    const limiter = windows();
    for (let i = 0; i < 5; i++) expect((await limiter.consume(rosa, 'linked')).allowed).toBe(true);
    expect((await limiter.consume(rosa, 'linked')).allowed).toBe(false);

    const guild = 'guild:900000000000000001';
    for (let i = 0; i < 8; i++) expect((await limiter.consume(guild, 'guild')).allowed).toBe(true);
    expect((await limiter.consume(guild, 'guild')).allowed).toBe(false);
  });

  it('counts each subject on its own', async () => {
    const limiter = windows();
    const other = 'user:301422551071492041';
    for (let i = 0; i < 3; i++) await limiter.consume(rosa, 'unlinked');
    expect((await limiter.consume(rosa, 'unlinked')).allowed).toBe(false);
    expect((await limiter.consume(other, 'unlinked')).allowed).toBe(true);
  });

  it('does not count a command it refused, so a refusal cannot lengthen the wait', async () => {
    const limiter = windows();
    for (let i = 0; i < 3; i++) await limiter.consume(rosa, 'unlinked');
    await limiter.consume(rosa, 'unlinked');
    await limiter.consume(rosa, 'unlinked');
    const rows = await db.select().from(rateWindows);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(3);
  });

  it('keeps one bucket per minute and counts every bucket in the window', async () => {
    const limiter = windows();
    await limiter.consume(rosa, 'linked');
    await limiter.consume(rosa, 'linked');
    clock = new Date('2026-09-05T14:31:05Z');
    await limiter.consume(rosa, 'linked');

    const rows = await db.select().from(rateWindows);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.count).sort()).toEqual([1, 2]);
    expect((await limiter.consume(rosa, 'linked')).used).toBe(3);
  });

  it('slides: a bucket leaves the window exactly one hour after its minute began', async () => {
    const limiter = windows();
    for (let i = 0; i < 3; i++) await limiter.consume(rosa, 'unlinked');
    expect((await limiter.consume(rosa, 'unlinked')).allowed).toBe(false);

    // Fifty nine minutes later the first bucket is still inside the window.
    clock = new Date('2026-09-05T15:29:59Z');
    expect((await limiter.consume(rosa, 'unlinked')).allowed).toBe(false);

    // One minute more and the bucket the three commands landed in is outside it.
    clock = new Date('2026-09-05T15:30:00Z');
    const allowed = await limiter.consume(rosa, 'unlinked');
    expect(allowed.allowed).toBe(true);
    expect(allowed.used).toBe(0);
  });

  it('names the wait as the seconds until the oldest bucket leaves the window', async () => {
    const limiter = windows();
    for (let i = 0; i < 3; i++) await limiter.consume(rosa, 'unlinked');
    // The bucket began at 14:30:00 and leaves at 15:30:00, and the clock says
    // 14:30:20, so the wait is the three thousand five hundred and eighty
    // seconds between them.
    const refused = await limiter.consume(rosa, 'unlinked');
    expect(refused.retryAfterSeconds).toBe(3580);
  });

  it('names a wait of at least one second, so a sentence never says to wait no time at all', async () => {
    const limiter = windows();
    for (let i = 0; i < 3; i++) await limiter.consume(rosa, 'unlinked');
    clock = new Date('2026-09-05T15:29:59.500Z');
    const refused = await limiter.consume(rosa, 'unlinked');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('sweeps buckets that are past their use and leaves the ones still counted', async () => {
    const limiter = createRateWindows({
      db,
      now,
      limits: { unlinkedPerHour: 3, linkedPerHour: 5, guildPerHour: 8 },
      keepMinutes: 120,
    });
    await limiter.consume(rosa, 'linked');
    clock = new Date('2026-09-05T17:00:00Z');
    await limiter.consume(rosa, 'linked');

    // The first bucket is two and a half hours old and the second is new.
    const removed = await limiter.sweep();
    expect(removed).toBe(1);
    const rows = await db.select().from(rateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucketStart).toBe('2026-09-05 17:00:00');
  });

  it('sweeps nothing when every bucket is still inside the window it keeps', async () => {
    const limiter = windows();
    await limiter.consume(rosa, 'linked');
    expect(await limiter.sweep()).toBe(0);
    expect(await db.select().from(rateWindows)).toHaveLength(1);
  });

  it('names a subject by the kind of thing it is', () => {
    expect(userSubject('204255221017214977')).toBe('user:204255221017214977');
    expect(guildSubject('900000000000000001')).toBe('guild:900000000000000001');
  });
});
