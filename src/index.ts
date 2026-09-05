import { readFileSync } from 'node:fs';
import { REST } from 'discord.js';
import { loadConfig } from './config.ts';
import { startHealthServer } from './health.ts';
import { db, pool } from './db/client.ts';
import { currentVersion } from './db/migrate.ts';
import { createViaHttpClient } from './via/http.ts';
import { withHotReadCache } from './via/cache.ts';
import { createGateway } from './discord/client.ts';
import { createGuildStore } from './guilds/store.ts';
import { createGuildLifecycle } from './guilds/lifecycle.ts';
import { createFeatureDisabler } from './guilds/disable.ts';
import {
  createDirectMessageDelivery, createDirectMessageSender,
} from './discord/directMessages.ts';
import { createDiscordActions, toScheduledEventInterest } from './discord/adapter.ts';
import { buildCommands, putCommands } from './discord/registerCommands.ts';
import { createRateWindows } from './ratelimit/windows.ts';
import { createDispatcher, deleteLocalData } from './commands/index.ts';
import { createDeliveries } from './delivery/deliveries.ts';
import { createFeedStore } from './feed/store.ts';
import { createEventMirrors } from './mirror/eventMirrors.ts';
import { createScheduledEventMirror } from './mirror/scheduledEvents.ts';
import { createInterestRecorder } from './mirror/interest.ts';
import { createAnnouncementHandlers } from './announce/handlers.ts';
import { createMidtermHandlers } from './announce/midterms.ts';
import { createThisWeekMessage } from './announce/thisWeek.ts';
import { createOutboxCursors } from './outbox/cursor.ts';
import { createOutboxConsumer } from './outbox/consumer.ts';
import { createMirrorWindowJob } from './jobs/mirrorWindow.ts';
import { createJobRuns } from './jobs/runs.ts';
import { createJobScheduler } from './jobs/scheduler.ts';
import { createPersonalDigestJob } from './jobs/personalDigest.ts';
import { createPersonalReminderJob } from './jobs/personalReminders.ts';
import { createGuildDigestJob } from './jobs/guildDigest.ts';
import { createDayOfReminderJob } from './jobs/dayOfReminders.ts';
import { createExamReminderJob } from './jobs/examReminders.ts';
import { createGuildExamsJob } from './jobs/guildExams.ts';

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

/**
 * The web platform client, with the two hot reads cached for a minute. The
 * cache sits outside the HTTP client so that everything past this line, the
 * commands and the autocomplete alike, reads through it.
 */
const via = withHotReadCache(createViaHttpClient({
  baseUrl: config.viaInternalUrl,
  serviceToken: config.botServiceToken,
}));

const guilds = createGuildStore(db);
const feed = createFeedStore(db);
const guildLifecycle = createGuildLifecycle({ guilds });
const deliveries = createDeliveries(db);
const mirrors = createEventMirrors(db);
const cursors = createOutboxCursors(db);
const jobRuns = createJobRuns(db);

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
  onGuildCreate: raw => guildLifecycle.onGuildCreate(raw),
  onGuildDelete: raw => guildLifecycle.onGuildDelete(raw),
  onScheduledEventInterest: (rawEvent, rawUser, interested) =>
    recordInterest(toScheduledEventInterest(rawEvent, rawUser), interested),
});

/**
 * Everything proactive hangs off the gateway's client, so it is built after
 * the gateway and before the dispatcher, which needs the scheduled event
 * mirror to clear a server on removal.
 */
const actions = createDiscordActions(gateway.client);
const sendDirectMessage = createDirectMessageSender(gateway.client);
const deliverDirectMessage = createDirectMessageDelivery(gateway.client);
const disable = createFeatureDisabler({ guilds, deliveries, sendDirectMessage });

const scheduledEvents = createScheduledEventMirror({
  guilds,
  mirrors,
  deliveries,
  actions,
  via,
  disable,
  now: () => new Date(),
});

const recordInterest = createInterestRecorder({ via, mirrors });

/**
 * The living this week message, which two things bring up to date: the hourly
 * job below, so that an event which has happened leaves the list, and the
 * outbox handlers, so that a meeting moved at nine in the morning is right in
 * the channel at one minute past.
 */
const thisWeek = createThisWeekMessage({ guilds, deliveries, actions, via, disable });

const consumer = createOutboxConsumer({
  via,
  cursors,
  /**
   * The handlers of both kinds of entry, in one map keyed by kind. The event
   * and series entries reach the servers that follow an organization, and the
   * midterm entries reach the people who added a course, which is why they are
   * two modules rather than one.
   */
  handlers: {
    ...createAnnouncementHandlers({
      guilds,
      mirrors,
      deliveries,
      actions,
      via,
      disable,
      websiteUrl: config.viaPublicUrl,
      mirror: scheduledEvents,
      thisWeek,
    }),
    ...createMidtermHandlers({ feed, deliveries, deliver: deliverDirectMessage }),
  },
  // The cache is dropped for an organization the moment an entry touches it,
  // so a change made on the website shows in Discord within seconds.
  invalidateRso: rsoId => via.invalidateRso(rsoId),
});

const mirrorWindow = createMirrorWindowJob({ guilds, mirror: scheduledEvents });

/**
 * The timed posts, on one clock.
 *
 * The four hourly jobs are the ones whose work belongs to a particular hour,
 * so a bot that was down over a digest hour sends that digest when it returns.
 * The three of the tick cadence are the ones whose work is due at a moment
 * somebody chose, and everything they owe is already written down in
 * Reminders, in User_Courses and in the events and exams themselves.
 */
const personalDigest = createPersonalDigestJob({
  feed, deliveries, via, deliver: deliverDirectMessage,
});
const personalReminders = createPersonalReminderJob({
  feed, deliveries, via, deliver: deliverDirectMessage,
});
const guildDigest = createGuildDigestJob({ guilds, deliveries, actions, via, disable });
const guildExams = createGuildExamsJob({ guilds, deliveries, actions, via, disable });
const examReminders = createExamReminderJob({
  feed, deliveries, via, deliver: deliverDirectMessage,
});
const dayOfReminders = createDayOfReminderJob({
  guilds, deliveries, actions, via, disable, websiteUrl: config.viaPublicUrl,
});

const scheduler = createJobScheduler({
  runs: jobRuns,
  jobs: [
    { name: 'personal.digest', async run(hour) { await personalDigest.run(hour); } },
    { name: 'guild.digest', async run(hour) { await guildDigest.run(hour); } },
    { name: 'guild.exams', async run(hour) { await guildExams.run(hour); } },
    { name: 'living.thisweek', async run(hour) { await thisWeek.refreshAll(hour.at); } },
    { name: 'personal.reminders', cadence: 'tick', async run(hour) { await personalReminders.run(hour); } },
    { name: 'guild.dayof', cadence: 'tick', async run(hour) { await dayOfReminders.run(hour); } },
    { name: 'personal.exams', cadence: 'tick', async run(hour) { await examReminders.run(hour); } },
  ],
});

const dispatch = createDispatcher({
  via,
  guilds,
  feed,
  websiteUrl: config.viaPublicUrl,
  rateWindows,
  deleteLocalData: discordUserId => deleteLocalData(db, discordUserId),
  removeGuildPresence: guildId => scheduledEvents.removeGuildPresence(guildId),
  sendDirectMessage: async (discordUserId, content) => {
    await sendDirectMessage(discordUserId, content);
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
  outboxConsumer: () => consumer.state(),
  scheduler: () => scheduler.state(),
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

/**
 * The consumer and the daily job start once the gateway is up, because both
 * of them post into Discord and neither can until there is a connection to
 * post through. Neither loop is awaited: they run until the process stops.
 */
void consumer.start();
console.log('via-bot: the outbox consumer is running');
void mirrorWindow.start();
console.log('via-bot: the mirroring window will be rolled daily');
void scheduler.start();
console.log('via-bot: the digests, the reminders, the exams and the this week message are on the clock');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    // The loops stop before the connections they use go, so that nothing is
    // half way through a post when the pool closes under it.
    await consumer.stop();
    await mirrorWindow.stop();
    await scheduler.stop();
    await gateway.destroy();
    await health.close();
    await pool.end();
    process.exit(0);
  });
}
