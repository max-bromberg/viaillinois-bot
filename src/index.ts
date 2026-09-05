import { readFileSync } from 'node:fs';
import { REST } from 'discord.js';
import { loadConfig } from './config.ts';
import { startHealthServer } from './health.ts';
import { db, pool } from './db/client.ts';
import { currentVersion } from './db/migrate.ts';
import { createViaHttpClient } from './via/http.ts';
import { createGateway } from './discord/client.ts';
import { createDirectMessageSender } from './discord/directMessages.ts';
import { buildCommands, putCommands } from './discord/registerCommands.ts';
import { createRateWindows } from './ratelimit/windows.ts';
import { createDispatcher, deleteLocalData } from './commands/index.ts';

/**
 * The bot's entry point, which is the one place everything is wired together.
 *
 * Order matters here. The health listener starts first, so the container can
 * be probed while the rest comes up and the cutover sees a bot that is not
 * ready rather than a port that refuses connections. The commands are put to
 * Discord before the gateway connects, so the first interaction the bot ever
 * receives is one it can answer. The gateway connects last.
 *
 * Nothing in this file makes a decision. Every decision is in a module with
 * a test, and this file only says which implementation each of them gets.
 */

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const config = loadConfig();

const via = createViaHttpClient({
  baseUrl: config.viaInternalUrl,
  serviceToken: config.botServiceToken,
});

const rateWindows = createRateWindows({ db, limits: config.rateLimits });

/**
 * Work a command asked to have done after the person was answered, which in
 * this increment is watching for a link. It is deliberately not awaited: the
 * interaction is finished, and a failure is the module's own to log.
 */
function schedule(task: () => Promise<void>): void {
  void task().catch(err => console.error('scheduled work failed:', (err as Error).message));
}

const gateway = createGateway({
  token: config.discordToken,
  dispatch: raw => dispatch(raw),
});

const dispatch = createDispatcher({
  via,
  rateWindows,
  deleteLocalData: discordUserId => deleteLocalData(db, discordUserId),
  sendDirectMessage: async (discordUserId, content) => {
    await createDirectMessageSender(gateway.client)(discordUserId, content);
  },
  schedule,
  now: () => new Date(),
  sleep: milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
});

const health = await startHealthServer({
  version,
  migrationVersion: currentVersion,
  gateway: () => gateway.isConnected(),
  database: async () => {
    await pool.query('SELECT 1');
    return true;
  },
  viaPlatform: () => via.health(),
}, config.healthPort);

console.log(`via-bot ${version}: health listening on port ${health.port}`);

const commands = buildCommands();
const registered = await putCommands({
  rest: new REST({ version: '10' }).setToken(config.discordToken),
  applicationId: config.discordApplicationId,
  commands,
});
console.log(`via-bot: registered ${registered} application commands`);

await gateway.login();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await gateway.destroy();
    await health.close();
    await pool.end();
    process.exit(0);
  });
}
