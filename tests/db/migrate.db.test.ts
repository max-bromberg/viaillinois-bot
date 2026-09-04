import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { startTestDb, resetTestDb, testDbConfig, useTestDbEnvironment } from '../support/testDb.ts';

let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let currentVersion: typeof import('../../src/db/migrate.ts').currentVersion;

/** Every table section 7 of the design lists, which the baseline has to create. */
const DESIGNED_TABLES = [
  'Guild_Installations',
  'Guild_Followed_Rsos',
  'Guild_Features',
  'Guild_Channels',
  'Guild_Role_Mappings',
  'Event_Mirrors',
  'Deliveries',
  'Subscriptions',
  'User_Preferences',
  'Reminders',
  'User_Courses',
  'Outbox_Cursor',
  'Rate_Windows',
];

describe('migration runner', () => {
  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ applyMigrations, currentVersion } = await import('../../src/db/migrate.ts'));
  }, 180_000);

  beforeEach(async () => { await resetTestDb(); });

  it('reports no version on a database with no migrations applied', async () => {
    expect(await currentVersion()).toBe(null);
  });

  it('applies every pending migration from an empty database and reports a version', async () => {
    const result = await applyMigrations();
    expect(result.applied).toBeGreaterThan(0);
    expect(result.version).toEqual(expect.any(String));
    expect(await currentVersion()).toBe(result.version);
  });

  /**
   * The version travels into the deploy log and the health response, where a
   * person reads it. A bare sha256 hash tells them nothing about which
   * migration is actually applied.
   */
  it('reports the migration name rather than its hash', async () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../src/db/migrations/meta/_journal.json', import.meta.url), 'utf8')
    );
    const latest = journal.entries[journal.entries.length - 1].tag;

    const result = await applyMigrations();
    expect(result.version).toBe(latest);
    expect(await currentVersion()).toBe(latest);
  });

  it('is idempotent: a second run applies nothing and keeps the version', async () => {
    const first = await applyMigrations();
    const second = await applyMigrations();
    expect(second.applied).toBe(0);
    expect(second.version).toBe(first.version);
  });

  it('creates every table the design lists', async () => {
    await applyMigrations();
    const conn = await mysql.createConnection(testDbConfig);
    const [rows] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
      [testDbConfig.database]
    );
    await conn.end();
    const tables = (rows as Array<{ t: string }>).map(r => r.t);
    expect(tables).toEqual(expect.arrayContaining(DESIGNED_TABLES));
  });

  it('stores Discord identifiers as strings, never as numbers', async () => {
    // Snowflakes exceed what a double holds exactly, so a numeric column
    // would round the top bits off silently.
    await applyMigrations();
    const conn = await mysql.createConnection(testDbConfig);
    const [rows] = await conn.query(
      `SELECT table_name AS t, column_name AS c, column_type AS ty
         FROM information_schema.columns
        WHERE table_schema = ? AND (column_name LIKE '%guild_id%' OR column_name LIKE '%discord_%_id%'
           OR column_name LIKE '%channel_id%' OR column_name LIKE '%message_id%' OR column_name LIKE '%role_id%')`,
      [testDbConfig.database]
    );
    await conn.end();
    const columns = rows as Array<{ t: string; c: string; ty: string }>;
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.ty, `${column.t}.${column.c}`).toBe('varchar(32)');
    }
  });

  it('refuses to run while another migration holds the lock', async () => {
    const holder = await mysql.createConnection(testDbConfig);
    await holder.query("SELECT GET_LOCK('via_bot_migrations', 0)");
    await expect(applyMigrations()).rejects.toThrow('another migration is in progress');
    await holder.query("SELECT RELEASE_LOCK('via_bot_migrations')");
    await holder.end();
  });
});
