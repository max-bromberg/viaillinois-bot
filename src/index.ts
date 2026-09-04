import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { startHealthServer } from './health.ts';
import { pool } from './db/client.ts';
import { currentVersion } from './db/migrate.ts';

/**
 * The bot's entry point.
 *
 * The gateway client, the web platform client and the commands are not built
 * yet, so for now this reads the configuration, starts the health listener,
 * and says so. The health endpoint answers 503 until the gateway exists,
 * which is the truth, and the cutover will not pass a bot in this state.
 */
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const config = loadConfig();

const health = await startHealthServer({
  version,
  migrationVersion: currentVersion,
  gateway: () => false,
  database: async () => {
    await pool.query('SELECT 1');
    return true;
  },
  viaPlatform: async () => {
    const response = await fetch(new URL('/health', config.viaInternalUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  },
}, config.healthPort);

console.log(`via-bot ${version}: health listening on port ${health.port}`);
console.log('via-bot: the gateway client is not built yet, so the bot is not connected to Discord.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await health.close();
    await pool.end();
    process.exit(0);
  });
}
