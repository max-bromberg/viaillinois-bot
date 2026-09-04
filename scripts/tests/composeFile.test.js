import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = readFileSync(join(root, 'docker-compose.test.yml'), 'utf8');

/**
 * The throwaway database is shared between the gate and a developer's machine,
 * so the port the test support connects to and the port the container
 * publishes have to come from the same place.
 */
describe('docker-compose.test.yml', () => {
  it('publishes the database on BOT_TEST_DB_PORT with 3308 as the default', () => {
    expect(compose).toContain('"${BOT_TEST_DB_PORT:-3308}:3306"');
  });

  it('creates the bot test database rather than the web platform one', () => {
    expect(compose).toContain('MYSQL_DATABASE: via_bot_test');
    expect(compose).not.toContain('via_test\n');
  });

  it('keeps the data on tmpfs so every run starts empty', () => {
    expect(compose).toContain('/var/lib/mysql');
    expect(compose).toContain('tmpfs:');
  });
});
