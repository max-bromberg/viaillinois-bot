import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createOutboxCursors: typeof import('../../src/outbox/cursor.ts').createOutboxCursors;
let ANNOUNCEMENTS_CONSUMER: typeof import('../../src/outbox/cursor.ts').ANNOUNCEMENTS_CONSUMER;

/**
 * The outbox cursor.
 *
 * The web platform keeps nothing about what the bot has read, so the cursor
 * is the bot's own and it is a row rather than a variable: a bot that
 * restarts has to carry on from the entry it finished, not from the beginning
 * of the outbox and not from wherever it happened to be in memory.
 */
describe('the outbox cursor', () => {
  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createOutboxCursors, ANNOUNCEMENTS_CONSUMER } = await import('../../src/outbox/cursor.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  const cursors = () => createOutboxCursors(db);

  it('starts at the beginning of the outbox for a consumer that has never read it', async () => {
    expect(await cursors().read(ANNOUNCEMENTS_CONSUMER)).toBe(0);
  });

  it('remembers the last entry a consumer finished', async () => {
    await cursors().advance(ANNOUNCEMENTS_CONSUMER, 7);
    expect(await cursors().read(ANNOUNCEMENTS_CONSUMER)).toBe(7);

    await cursors().advance(ANNOUNCEMENTS_CONSUMER, 11);
    expect(await cursors().read(ANNOUNCEMENTS_CONSUMER)).toBe(11);
  });

  it('keeps one cursor per consumer, so a second consumer can be added without a change', async () => {
    await cursors().advance(ANNOUNCEMENTS_CONSUMER, 7);
    await cursors().advance('roles', 3);
    expect(await cursors().read(ANNOUNCEMENTS_CONSUMER)).toBe(7);
    expect(await cursors().read('roles')).toBe(3);
  });

  it('names the consumer the first release runs, so the row is found again after a restart', () => {
    expect(ANNOUNCEMENTS_CONSUMER).toBe('announcements');
  });
});
