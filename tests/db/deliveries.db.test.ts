import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let deliveries: typeof import('../../src/db/schema.ts').deliveries;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;

/**
 * The outbox consumer writes one Deliveries row per intended post before
 * posting it, keyed by outbox entry, target and purpose, so that a crash
 * between the write and the post is retried and a crash after the post is
 * not. That guarantee is the database's unique key, so it is tested there.
 */
describe('Deliveries', () => {
  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ deliveries } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  const intended = {
    outboxId: 42,
    target: 'channel:123456789012345678',
    purpose: 'announcements',
    kind: 'message' as const,
  };

  it('records an intended post once', async () => {
    await db.insert(deliveries).values(intended);
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outboxId).toBe(42);
    expect(rows[0]!.target).toBe('channel:123456789012345678');
    expect(rows[0]!.deliveredAt).toBe(null);
  });

  it('refuses a second row for the same outbox entry, target and purpose', async () => {
    await db.insert(deliveries).values(intended);
    // Drizzle wraps the driver error and keeps the MySQL error code on cause.
    const failure = await db.insert(deliveries).values(intended).then(() => null, (err: Error) => err);
    expect(failure).not.toBe(null);
    expect(((failure as any).cause ?? failure).code).toBe('ER_DUP_ENTRY');
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(1);
  });

  it('allows the same outbox entry to reach a second target or serve a second purpose', async () => {
    await db.insert(deliveries).values(intended);
    await db.insert(deliveries).values({ ...intended, target: 'channel:987654321098765432' });
    await db.insert(deliveries).values({ ...intended, purpose: 'digest' });
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(3);
  });

  it('reads datetime columns back as the strings they were written as', async () => {
    // The pool is configured with dateStrings, as the web platform's is, so
    // campus wall clock is never reinterpreted in the process's zone.
    await db.insert(deliveries).values({ ...intended, deliveredAt: '2026-09-04 18:30:00' });
    const rows = await db.select().from(deliveries);
    expect(rows[0]!.deliveredAt).toBe('2026-09-04 18:30:00');
  });
});
