import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';

const run = promisify(execFile);
const COMPOSE_FILE = new URL('../../docker-compose.test.yml', import.meta.url).pathname;

/**
 * The host port the throwaway database publishes. docker-compose.test.yml
 * reads the same variable, so the two cannot disagree. The default leaves
 * 3307 to the web platform's own throwaway database.
 */
export const TEST_DB_PORT = parseInt(process.env.BOT_TEST_DB_PORT || '3308', 10);

export const testDbConfig = {
  host:     '127.0.0.1',
  port:     TEST_DB_PORT,
  user:     'root',
  password: 'test_root_pw',
  database: 'via_bot_test',
  multipleStatements: true,
};

/**
 * Bring up the throwaway MySQL container and wait until it accepts queries.
 * Waiting on the container healthcheck is not enough: MySQL reports healthy
 * shortly before it finishes its first-boot initialization, so we poll with a
 * real connection instead.
 */
export async function startTestDb(): Promise<void> {
  await composeUp();
  const deadline = Date.now() + 120_000;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection({ ...testDbConfig, database: undefined });
      await conn.query('CREATE DATABASE IF NOT EXISTS via_bot_test');
      await conn.end();
      return;
    } catch (err) {
      lastError = err as Error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`test database did not become ready: ${lastError?.message}`);
}

/**
 * Bring the container up, tolerating a concurrent caller. Two simultaneous
 * compose invocations against the same container can fail transiently while
 * docker publishes the port. The command is idempotent, so retrying is safe.
 */
async function composeUp(): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'test-db']);
      return;
    } catch (err) {
      lastError = err as Error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`could not start the test database container: ${lastError?.message}`);
}

export async function stopTestDb(): Promise<void> {
  await run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v']);
}

/** Drop and recreate the schema so each suite starts from a known empty state. */
export async function resetTestDb(): Promise<void> {
  const conn = await mysql.createConnection({ ...testDbConfig, database: undefined });
  await conn.query('DROP DATABASE IF EXISTS via_bot_test');
  await conn.query('CREATE DATABASE via_bot_test');
  await conn.end();
}

/**
 * Point the bot's own database configuration at the throwaway database, the
 * way the deployed stack points it at the real one. Called before the modules
 * under src/db are imported, because they read the environment on import.
 */
export function useTestDbEnvironment(): void {
  process.env.DB_HOST = testDbConfig.host;
  process.env.DB_PORT = String(testDbConfig.port);
  process.env.BOT_DB_USER = testDbConfig.user;
  process.env.BOT_DB_PASSWORD = testDbConfig.password;
  process.env.BOT_DB_NAME = testDbConfig.database;
}
