import { readFileSync } from 'node:fs';
import { REST } from 'discord.js';
import { loadConfig } from './config.ts';
import { heldFor, startHealthServer } from './health.ts';
import { db, pool } from './db/client.ts';
import { currentVersion } from './db/migrate.ts';
import { createViaHttpClient } from './via/http.ts';
import { withHotReadCache } from './via/cache.ts';
import { createNetIdDirectory, withNetIdDirectory } from './roles/directory.ts';
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
import { createInterestMarks } from './feed/interestMarks.ts';
import { createEventMirrors } from './mirror/eventMirrors.ts';
import { createScheduledEventMirror } from './mirror/scheduledEvents.ts';
import { createInterestRecorder } from './mirror/interest.ts';
import { createAnnouncementHandlers } from './announce/handlers.ts';
import { createMidtermHandlers } from './announce/midterms.ts';
import { createMembershipHandlers } from './announce/membership.ts';
import { createLinkHandlers } from './identity/links.ts';
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
import { createFeedbackJob, FEEDBACK_HOUR } from './jobs/feedback.ts';
import { createHousekeepingJob, HOUSEKEEPING_HOUR } from './jobs/housekeeping.ts';
import { createGuildExamsJob } from './jobs/guildExams.ts';
import { createPollClosingJob } from './jobs/schedulerPolls.ts';
import { createRoleReconciliationJob } from './jobs/roleReconcile.ts';
import { createRoleGrants } from './roles/grants.ts';
import { createMembershipRoles } from './roles/membership.ts';
import { registerLinkedRoleMetadata } from './roles/linked.ts';
import { createSchedulerPolls } from './scheduler/polls.ts';

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

/**
 * The campus hour the membership roles are reconciled at, which is early
 * enough to be done before anybody reads a channel and late enough that a
 * membership changed the evening before is already in the outbox.
 */
const ROLE_RECONCILE_HOUR = 5;

const config = loadConfig();

/**
 * Who a NetID is, for an hour at a time and in memory only. The bot stores no
 * NetID, so this is what lets a membership entry, which names a person by
 * NetID, reach the Discord account a role is given to. It is filled by the
 * link lookups the bot already makes, which is what the wrapper below does.
 */
const netIds = createNetIdDirectory();

/**
 * The web platform client, with the two hot reads cached for a minute. The
 * cache sits outside the HTTP client so that everything past this line, the
 * commands and the autocomplete alike, reads through it.
 */
const via = withHotReadCache(withNetIdDirectory(createViaHttpClient({
  baseUrl: config.viaInternalUrl,
  serviceToken: config.botServiceToken,
}), netIds));

const guilds = createGuildStore(db);
const feed = createFeedStore(db);
/**
 * Who marked interest in which event, by Discord account, which is the one
 * thing the feedback request the morning after cannot ask the web platform
 * for: it holds interest by NetID, and the bot holds no NetID.
 */
const interestMarks = createInterestMarks(db);
const guildLifecycle = createGuildLifecycle({ guilds });
const deliveries = createDeliveries(db);
const mirrors = createEventMirrors(db);
const cursors = createOutboxCursors(db);
const jobRuns = createJobRuns(db);
const grants = createRoleGrants(db);
const polls = createSchedulerPolls(db);

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

const recordInterest = createInterestRecorder({ via, mirrors, marks: interestMarks });

/**
 * The membership roles a server maps, kept in step by the outbox as
 * memberships change and by the daily reconciliation for everybody the outbox
 * could not name at the time.
 */
const membershipRoles = createMembershipRoles({ guilds, grants, actions, disable });

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
      feed,
      deliver: deliverDirectMessage,
      disable,
      websiteUrl: config.viaPublicUrl,
      mirror: scheduledEvents,
      thisWeek,
    }),
    ...createMidtermHandlers({ feed, deliveries, via, deliver: deliverDirectMessage }),
    ...createMembershipHandlers({ guilds, roles: membershipRoles, directory: netIds }),
    /**
     * The two ends of linking. The web platform records the link and the bot
     * confirms it, and an unlink made on the website reaches the bot only
     * here, which is where everything it held for that account is deleted.
     */
    ...createLinkHandlers({
      deliveries,
      deliver: deliverDirectMessage,
      directory: netIds,
      deleteLocalData: discordUserId => deleteLocalData(db, discordUserId, { roles: membershipRoles }),
    }),
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
const feedbackRequests = createFeedbackJob({
  feed, marks: interestMarks, guilds, deliveries, via, deliver: deliverDirectMessage,
});

const closingPolls = createPollClosingJob({ polls, actions });

/**
 * The daily housekeeping: the ninety day retention of section 10, and the
 * rebuild that a cursor older than the outbox retention asks for. The health
 * endpoint reports both, because neither is anything a person would notice
 * until it had been going wrong for a long time.
 */
const housekeeping = createHousekeepingJob({
  deliveries, rateWindows, cursors, guilds, mirror: scheduledEvents,
});

const roleReconciliation = createRoleReconciliationJob({
  guilds, roles: membershipRoles, grants, directory: netIds, via,
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
    // A poll closes at an hour Discord decides rather than one the campus
    // clock does, and Discord sends no event to say so, so the bot looks on
    // every pass for the polls whose time is up.
    { name: 'scheduler.polls', cadence: 'tick', async run(hour) { await closingPolls.run(hour); } },
    // The housekeeping runs once a day, in the quietest hour of the campus
    // day, and the hourly cadence catches it up like everything else.
    {
      name: 'housekeeping',
      async run(hour) {
        if (hour.hour !== HOUSEKEEPING_HOUR) return;
        await housekeeping.run(hour);
      },
    },
    // The feedback requests go out once a day, the morning after the events
    // they are about, and the hourly cadence is what makes a bot that was down
    // over that hour still send them when it returns.
    {
      name: 'feedback.request',
      async run(hour) {
        if (hour.hour !== FEEDBACK_HOUR) return;
        const report = await feedbackRequests.run(hour);
        if (report.events > 0) {
          console.log(
            `via-bot: asked for feedback on ${report.events} events, `
            + `${report.sent} messages sent, ${report.skipped} people passed over`,
          );
        }
      },
    },
    // The roles are reconciled once a day, at the hour the design names, and
    // the hourly cadence is what makes a bot that was down over it catch up.
    {
      name: 'roles.reconcile',
      async run(hour) {
        if (hour.hour !== ROLE_RECONCILE_HOUR) return;
        const report = await roleReconciliation.run(hour);
        console.log(
          `via-bot: reconciled the roles of ${report.servers} servers, `
          + `${report.people} people, ${report.unresolved} left for another day`,
        );
      },
    },
  ],
});

const dispatch = createDispatcher({
  via,
  guilds,
  feed,
  interestMarks,
  websiteUrl: config.viaPublicUrl,
  rateWindows,
  polls,
  mirrors,
  postMessage: (channelId, reply) => actions.postMessage(channelId, reply),
  postPoll: (channelId, poll) => actions.postPoll(channelId, poll),
  deleteLocalData: discordUserId => deleteLocalData(db, discordUserId, { roles: membershipRoles }),
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
  /**
   * The answer the web platform gave, held for a few seconds, so that a burst
   * of hits on the health port is one call to the internal service API rather
   * than one each.
   */
  viaPlatform: heldFor(() => via.health()),
  outboxConsumer: () => consumer.state(),
  scheduler: () => scheduler.state(),
  housekeeping: () => housekeeping.state(),
}, config.healthPort);

console.log(`via-bot ${version}: health listening on port ${health.port}`);

const rest = new REST({ version: '10' }).setToken(config.discordToken);

/**
 * Everything past the health listener is allowed to fail without taking the
 * process with it.
 *
 * The listener is bound by this point, so a throw here would be a container
 * that answers its port for a moment and then exits, which reads as a crash
 * loop rather than as a bot that cannot reach Discord. The honest state is a
 * process that keeps running and a health endpoint that says what is wrong,
 * which is what the cutover gates on and what a person looking at the logs
 * needs to see.
 */
async function attempt(what: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    console.error(`via-bot: ${what} failed:`, (err as Error).message);
    return false;
  }
}

await attempt('registering the application commands', async () => {
  const registered = await putCommands({
    rest,
    applicationId: config.discordApplicationId,
    commands: buildCommands(),
  });
  console.log(`via-bot: registered ${registered} application commands`);
});

/**
 * The facts a server can require for a role of its own. Registering them is
 * the bot's whole part in linked roles: the values themselves are pushed by
 * the web platform, which holds the Discord authorization from the link flow.
 */
await attempt('registering the linked role facts', async () => {
  const facts = await registerLinkedRoleMetadata({
    rest,
    applicationId: config.discordApplicationId,
  });
  console.log(`via-bot: registered ${facts} linked role facts`);
});

/** How long the bot waits before trying the gateway again after a login that failed. */
const LOGIN_RETRY_MS = 30_000;

let loopsRunning = false;
let loginRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * The loops that post into Discord, started once the gateway is up, because
 * every one of them posts through it. Nothing here is awaited: they run until
 * the process stops, and a loop that ended because it threw would leave the
 * bot silent with nothing in the log, so each of them says so.
 */
async function startLoops(): Promise<void> {
  if (loopsRunning) return;
  loopsRunning = true;

  // The posts the bot was still owed when it last stopped. This reads the
  // outbox again from the oldest entry carrying one, and the delivery rows are
  // what stop anything already posted being posted twice.
  await attempt('draining the posts that were still owed', async () => {
    await housekeeping.drainPending();
  });

  void consumer.start().catch(err =>
    console.error('via-bot: the outbox consumer stopped:', (err as Error).message));
  console.log('via-bot: the outbox consumer is running');
  void mirrorWindow.start().catch(err =>
    console.error('via-bot: the mirroring window loop stopped:', (err as Error).message));
  console.log('via-bot: the mirroring window will be rolled daily');
  void scheduler.start().catch(err =>
    console.error('via-bot: the job scheduler stopped:', (err as Error).message));
  console.log('via-bot: the digests, the reminders, the exams and the this week message are on the clock');
}

/**
 * Connect to the gateway, and keep trying.
 *
 * Discord has outages, and a bot that exits on the first refused login is a
 * container that restarts every few seconds until the outage is over. So a
 * login that failed is logged and tried again on a timer, and the health
 * endpoint reports the gateway as down for as long as it is, which is exactly
 * what it is for.
 */
async function connect(): Promise<void> {
  if (await attempt('connecting to the Discord gateway', () => gateway.login())) {
    loginRetry = null;
    console.log('via-bot: the gateway is connected');
    await startLoops();
    return;
  }

  console.log(`via-bot: trying the gateway again in ${LOGIN_RETRY_MS / 1000} seconds`);
  loginRetry = setTimeout(() => { void connect(); }, LOGIN_RETRY_MS);
}

await connect();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    // The loops stop before the connections they use go, so that nothing is
    // half way through a post when the pool closes under it.
    if (loginRetry) clearTimeout(loginRetry);
    await consumer.stop();
    await mirrorWindow.stop();
    await scheduler.stop();
    await gateway.destroy();
    await health.close();
    await pool.end();
    process.exit(0);
  });
}
