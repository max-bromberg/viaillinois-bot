import { migrate } from 'drizzle-orm/mysql2/migrator';
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import db from './client.ts';
import { adminConfigFromEnv } from './pool.ts';

const LOCK_NAME = 'via_bot_migrations';
const MIGRATIONS_FOLDER = new URL('./migrations', import.meta.url).pathname;

/** Unwrap the first row of a mysql2 result, which arrives as a tuple. */
function firstRow(result: unknown): any {
  const rows = result as unknown as any[];
  return rows[0]?.[0] ?? rows[0];
}

/**
 * Run against a single administrative connection.
 *
 * Two reasons this is not the application pool. Schema changes need
 * privileges the application account does not have. And GET_LOCK is scoped
 * to one connection, so taking the lock on a pool could release it from a
 * different connection than the one holding it.
 */
async function withAdminConnection<T>(fn: (adminDb: any) => Promise<T>): Promise<T> {
  const config = adminConfigFromEnv();
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });
  try {
    return await fn(drizzle(connection));
  } finally {
    await connection.end();
  }
}

/** Hash of a migration file, computed the way the migrator computes it. */
function hashOf(tag: string): string {
  return createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`)))
    .digest('hex');
}

/**
 * Name of the migration a stored hash belongs to.
 *
 * The bookkeeping table records hashes, but the version travels into the
 * deploy log and the health response, where a person reads it. Falls back to
 * the hash when no file matches, which means the applied migration is not one
 * this checkout knows about, and that is worth seeing rather than hiding.
 */
function tagForHash(hash: string): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  for (const entry of journal.entries) {
    try {
      if (hashOf(entry.tag) === hash) return entry.tag;
    } catch {
      // A journal entry without a file is not this function's problem to report.
    }
  }
  return hash;
}

/** Most recently applied migration on the given client, by name, or null if none. */
async function versionOn(client: any): Promise<string | null> {
  try {
    const rows = await client.execute(sql`
      SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1
    `);
    const hash = firstRow(rows)?.hash;
    return hash ? tagForHash(hash) : null;
  } catch {
    return null;
  }
}

/**
 * Read the most recently applied migration.
 * Returns null when the migrations table does not exist yet, which is the
 * state of a database that has never been migrated. This one runs on the
 * application pool, because the health endpoint calls it on every check.
 */
export async function currentVersion(): Promise<string | null> {
  return versionOn(db);
}

async function countApplied(client: any): Promise<number> {
  try {
    const rows = await client.execute(sql`SELECT COUNT(*) AS n FROM __drizzle_migrations`);
    return Number(firstRow(rows)?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Apply all pending migrations under a MySQL named lock.
 *
 * The lock is what prevents two concurrent deploys from migrating at the same
 * time. GET_LOCK with a zero timeout fails immediately rather than queueing,
 * because a deploy that waits behind another deploy is a deploy that should
 * stop and let a human look at it.
 *
 * The web platform's migrate script also stamps a database that predates its
 * migration system. This database has no such history, so nothing is stamped
 * here: an empty database runs the baseline.
 */
export async function applyMigrations(): Promise<{ applied: number; version: string }> {
  return withAdminConnection(async (client) => {
    const acquired = await client.execute(sql`SELECT GET_LOCK(${LOCK_NAME}, 0) AS got`);
    if (Number(firstRow(acquired)?.got) !== 1) {
      throw new Error('another migration is in progress');
    }

    try {
      const before = await countApplied(client);
      await migrate(client, { migrationsFolder: MIGRATIONS_FOLDER });
      const after = await countApplied(client);
      const version = await versionOn(client);
      if (version === null) {
        throw new Error('migrations applied but no version was recorded');
      }
      return { applied: after - before, version };
    } finally {
      await client.execute(sql`SELECT RELEASE_LOCK(${LOCK_NAME})`);
    }
  });
}

// Allow running as a script: `node --experimental-strip-types src/db/migrate.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  applyMigrations()
    .then(({ applied, version }) => {
      console.log(`migrations applied: ${applied}, version: ${version}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`migration failed: ${err.message}`);
      if (err.cause) console.error(`caused by: ${err.cause.message ?? err.cause}`);
      process.exit(1);
    });
}
