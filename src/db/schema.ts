import {
  mysqlTable, primaryKey, unique, index, int, json, varchar, tinyint, boolean, datetime, mysqlEnum,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';

/**
 * The bot's own database, via_bot.
 *
 * Every table here describes Discord: which servers the bot is in, what each
 * server enabled, who subscribed to what, and what the bot already posted.
 * Nothing here describes VIA itself, which the web platform owns. Discord
 * snowflakes are decimal strings wider than a double holds exactly, so every
 * Discord identifier is a varchar(32) and never a number. VIA identifiers are
 * the integers the web platform hands out. The bot never stores a NetID.
 *
 * Datetime columns hold campus wall clock and are read back as strings, as on
 * the web platform.
 */

/** A Discord snowflake column. */
const snowflake = (name: string) => varchar(name, { length: 32 });

/** A datetime column that records when its row was written. */
const stamp = (name: string) =>
  datetime(name, { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull();

/**
 * One row per server the bot is installed in: what kind of server it is,
 * what it is bound to, who ran setup and when, and the per server settings
 * that are not feature toggles. A binding of `set` is spelled out in
 * Guild_Followed_Rsos, and a binding of `rso` names the one RSO here.
 *
 * Kind and binding are both nullable, and both are null from the moment the
 * bot joins a server until a manager answers for it in setup. The design
 * says that nothing is posted and no channel is touched until setup has run,
 * so a server that was never asked what it is has to read back as one that
 * was never asked. Filling either column with a value the manager did not
 * choose would make a server that has answered nothing indistinguishable
 * from one that answered, which is the state the rest of the bot branches on.
 */
export const guildInstallations = mysqlTable('Guild_Installations', {
  guildId: snowflake('guild_id').notNull(),
  kind: mysqlEnum('kind', ['rso', 'community']),
  binding: mysqlEnum('binding', ['rso', 'all', 'set']),
  rsoId: int('rso_id'),
  installedBy: snowflake('installed_by').notNull(),
  installedAt: stamp('installed_at'),
  // How far ahead native scheduled events are mirrored. The design's default
  // is two weeks, adjustable per server.
  mirrorWindowDays: int('mirror_window_days').default(14).notNull(),
  // When the weekly digest is posted, on the campus clock, with days running
  // zero to six from Sunday. The defaults are the ones setup offers, which is
  // Sunday at six in the evening, so a server that switches the digest on
  // without opening the timing panel still posts at a sensible hour.
  digestDay: tinyint('digest_day').default(0).notNull(),
  digestHour: tinyint('digest_hour').default(18).notNull(),
  // How far ahead the day of reminders are posted.
  reminderLeadMinutes: int('reminder_lead_minutes').default(60).notNull(),
  // Whether each digest is pinned and the one before it unpinned.
  digestPinned: boolean('digest_pinned').default(false).notNull(),
  // The Discord account that bound this server to its organization, which the
  // web platform confirmed was on that organization's board at the time. The
  // daily role reconciliation reads the organization's members as this person,
  // because the members endpoint is board work and the bot has no identity of
  // its own on VIA. Null until a server is bound to one organization.
  boundBy: snowflake('bound_by'),
}, (table) => [
  primaryKey({ columns: [table.guildId], name: 'Guild_Installations_guild_id' }),
]);

/**
 * For a community server bound to a chosen set of RSOs, the RSOs in the set.
 * A server bound to one RSO or to all of ECE has no rows here.
 */
export const guildFollowedRsos = mysqlTable('Guild_Followed_Rsos', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  rsoId: int('rso_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.rsoId], name: 'Guild_Followed_Rsos_guild_id_rso_id' }),
]);

/**
 * One row per feature a server has changed from the registry default. A
 * feature with no row here is in its default state, so a change to the
 * default reaches every server that never touched that feature.
 */
export const guildFeatures = mysqlTable('Guild_Features', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  featureId: varchar('feature_id', { length: 64 }).notNull(),
  enabled: boolean('enabled').notNull(),
  updatedAt: stamp('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.featureId], name: 'Guild_Features_guild_id_feature_id' }),
]);

/**
 * One row per channel purpose a server has bound a channel to. A proactive
 * feature posts to the channel bound to its purpose and cannot be enabled
 * until one is.
 */
export const guildChannels = mysqlTable('Guild_Channels', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  channelId: snowflake('channel_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.purpose], name: 'Guild_Channels_guild_id_purpose' }),
]);

/**
 * A message the bot posted in a server and has to find again: the living this
 * week message, which it edits in place and keeps pinned, and the last weekly
 * digest, which it unpins when it pins the next one. One row per server and
 * purpose, replaced when the message is replaced.
 *
 * This is not Event_Mirrors, which holds what one event became in one server.
 * These messages are about a week rather than about an event, and there is at
 * most one of each per server.
 */
export const guildMessages = mysqlTable('Guild_Messages', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  channelId: snowflake('channel_id').notNull(),
  messageId: snowflake('message_id').notNull(),
  postedAt: stamp('posted_at'),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.purpose], name: 'Guild_Messages_guild_id_purpose' }),
]);

/**
 * VIA membership role to Discord role, per server. The bot only ever touches
 * the roles mapped here, and it never removes a role it did not grant.
 */
export const guildRoleMappings = mysqlTable('Guild_Role_Mappings', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  membershipRole: mysqlEnum('membership_role', ['member', 'editor', 'board']).notNull(),
  roleId: snowflake('role_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.membershipRole], name: 'Guild_Role_Mappings_guild_id_membership_role' }),
]);

/**
 * Every Discord role the bot itself gave somebody, and which VIA membership
 * role it was given for.
 *
 * Section 6.1 of the design says the bot never removes a role it did not
 * grant. A server may hand the same role out by hand, to an alumnus, to
 * somebody helping with an event, or to a person whose membership VIA has not
 * caught up with yet, and taking that away because VIA does not list them
 * would be the bot overruling the server about its own roles. So a row is
 * written here when the bot grants a role, and a role with no row here is left
 * alone for ever.
 */
export const roleGrants = mysqlTable('Role_Grants', {
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  discordUserId: snowflake('discord_user_id').notNull(),
  roleId: snowflake('role_id').notNull(),
  membershipRole: mysqlEnum('membership_role', ['member', 'editor', 'board']).notNull(),
  grantedAt: stamp('granted_at'),
}, (table) => [
  primaryKey({
    columns: [table.guildId, table.discordUserId, table.roleId],
    name: 'Role_Grants_guild_id_discord_user_id_role_id',
  }),
  index('idx_role_grants_guild').on(table.guildId),
]);

/**
 * A poll the scheduler opened over the evenings VIA recommended.
 *
 * Discord counts the votes and holds the answers, and this holds the two
 * things Discord cannot: which recommendation each answer stood for, so that
 * the winning answer can be turned back into a time and a room, and what was
 * asked for in the first place, so that the recommendation can be run again
 * when somebody accepts. It also holds when the poll closes, because Discord
 * sends no event of its own to say that a poll has ended and the bot reads the
 * result at the hour it knows the poll runs to.
 *
 * The candidates are what the bot itself wrote into the poll, never anything a
 * person typed, so nothing here is message content.
 */
export const schedulerPolls = mysqlTable('Scheduler_Polls', {
  pollId: int('poll_id').autoincrement().notNull(),
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  channelId: snowflake('channel_id').notNull(),
  messageId: snowflake('message_id').notNull(),
  rsoId: int('rso_id').notNull(),
  /** The Discord account that opened the poll, which is who the result names. */
  openedBy: snowflake('opened_by').notNull(),
  /** What was asked of the scheduler, so that accepting can ask it again. */
  request: json('request').notNull(),
  /** The evenings the poll offered, in the order Discord holds its answers. */
  candidates: json('candidates').notNull(),
  closesAt: datetime('closes_at', { mode: 'string' }).notNull(),
  /** When the result was posted, which is what stops it being posted twice. */
  closedAt: datetime('closed_at', { mode: 'string' }),
  createdAt: stamp('created_at'),
}, (table) => [
  primaryKey({ columns: [table.pollId], name: 'Scheduler_Polls_poll_id' }),
  unique('uq_scheduler_poll_message').on(table.guildId, table.messageId),
  index('idx_scheduler_polls_closes_at').on(table.closesAt),
]);

/**
 * What a VIA event became in a server: the Discord scheduled event that
 * mirrors it, and the announcement message that change notices edit in place
 * and reply to. Either side can be absent, because a server may mirror
 * without announcing or announce without mirroring.
 */
export const eventMirrors = mysqlTable('Event_Mirrors', {
  mirrorId: int('mirror_id').autoincrement().notNull(),
  guildId: snowflake('guild_id').notNull().references(() => guildInstallations.guildId, { onDelete: 'cascade' }),
  eventId: int('event_id').notNull(),
  scheduledEventId: snowflake('scheduled_event_id'),
  announcementChannelId: snowflake('announcement_channel_id'),
  announcementMessageId: snowflake('announcement_message_id'),
  createdAt: stamp('created_at'),
  updatedAt: stamp('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.mirrorId], name: 'Event_Mirrors_mirror_id' }),
  unique('uq_event_mirror').on(table.guildId, table.eventId),
  index('idx_event_mirrors_event').on(table.eventId),
]);

/**
 * Every post, edit and direct message the bot intended, written before the
 * post is made. The unique key over the outbox entry, the target and the
 * purpose is what makes delivery exactly once under any single failure: a
 * crash between the write and the post is retried, and a crash after the post
 * is not. The target names where the post goes, as `channel:` or `user:`
 * followed by the snowflake, or `guild:` for something that concerns a whole
 * server, such as the notice its manager is sent when a feature had to be
 * switched off. Rows are pruned after ninety days.
 */
export const deliveries = mysqlTable('Deliveries', {
  deliveryId: int('delivery_id').autoincrement().notNull(),
  outboxId: int('outbox_id').notNull(),
  target: varchar('target', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  kind: mysqlEnum('kind', ['message', 'edit', 'direct_message', 'scheduled_event']).notNull(),
  messageId: snowflake('message_id'),
  intendedAt: stamp('intended_at'),
  deliveredAt: datetime('delivered_at', { mode: 'string' }),
}, (table) => [
  primaryKey({ columns: [table.deliveryId], name: 'Deliveries_delivery_id' }),
  unique('uq_delivery').on(table.outboxId, table.target, table.purpose),
  index('idx_deliveries_intended_at').on(table.intendedAt),
]);

/**
 * A Discord user follows an RSO. Following everything is the follow_all flag
 * on User_Preferences rather than a row here, so that the primary key can
 * stay a plain pair of identifiers.
 */
export const subscriptions = mysqlTable('Subscriptions', {
  discordUserId: snowflake('discord_user_id').notNull(),
  rsoId: int('rso_id').notNull(),
  createdAt: stamp('created_at'),
}, (table) => [
  primaryKey({ columns: [table.discordUserId, table.rsoId], name: 'Subscriptions_discord_user_id_rso_id' }),
]);

/**
 * What a linked person asked the bot to do on its own: when the personal
 * digest arrives, how far ahead reminders come, whether they follow every
 * RSO, and the two opt outs. Days run zero to six from Sunday, hours are the
 * campus clock. Deleted with the link.
 */
export const userPreferences = mysqlTable('User_Preferences', {
  discordUserId: snowflake('discord_user_id').notNull(),
  digestDay: tinyint('digest_day'),
  digestHour: tinyint('digest_hour'),
  reminderLeadMinutes: int('reminder_lead_minutes').default(60).notNull(),
  followAll: boolean('follow_all').default(false).notNull(),
  feedbackOptOut: boolean('feedback_opt_out').default(false).notNull(),
  directMessageOptOut: boolean('direct_message_opt_out').default(false).notNull(),
  updatedAt: stamp('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.discordUserId], name: 'User_Preferences_discord_user_id' }),
]);

/**
 * One off reminders a person asked for from an event card, one per person
 * and event, due at a campus wall clock time. Sent reminders are deleted.
 */
export const reminders = mysqlTable('Reminders', {
  reminderId: int('reminder_id').autoincrement().notNull(),
  discordUserId: snowflake('discord_user_id').notNull(),
  eventId: int('event_id').notNull(),
  remindAt: datetime('remind_at', { mode: 'string' }).notNull(),
  createdAt: stamp('created_at'),
}, (table) => [
  primaryKey({ columns: [table.reminderId], name: 'Reminders_reminder_id' }),
  unique('uq_reminder').on(table.discordUserId, table.eventId),
  index('idx_reminders_remind_at').on(table.remindAt),
]);

/**
 * Who marked interest in an event, by Discord account.
 *
 * The web platform holds interest by NetID, and section 7 of the design says
 * the bot stores Discord identifiers and VIA identifiers and nothing that
 * identifies a person beyond those. So the bot cannot ask the web platform
 * who was interested in an event and turn the answer into Discord accounts,
 * and it keeps its own record of the marks it saw: one row per event and
 * Discord account, written when interest is forwarded to the web platform and
 * deleted when it is withdrawn.
 *
 * This is what the morning after job reads to decide who to ask for feedback,
 * and it holds nothing the bot did not already hold. The rows for an event go
 * once the feedback for it has been asked for, and the rows of a person go
 * when they unlink.
 */
export const interestMarks = mysqlTable('Interest_Marks', {
  eventId: int('event_id').notNull(),
  discordUserId: snowflake('discord_user_id').notNull(),
  markedAt: stamp('marked_at'),
}, (table) => [
  primaryKey({ columns: [table.eventId, table.discordUserId], name: 'Interest_Marks_event_id_discord_user_id' }),
  index('idx_interest_marks_user').on(table.discordUserId),
]);

/**
 * Courses a person added for exam reminders, by the course code the web
 * platform uses. Deleted with the link.
 */
export const userCourses = mysqlTable('User_Courses', {
  discordUserId: snowflake('discord_user_id').notNull(),
  courseCode: varchar('course_code', { length: 20 }).notNull(),
  createdAt: stamp('created_at'),
}, (table) => [
  primaryKey({ columns: [table.discordUserId, table.courseCode], name: 'User_Courses_discord_user_id_course_code' }),
]);

/**
 * The last outbox entry the consumer handled, advanced only after every
 * delivery for the entry is recorded. One row per consumer, and the first
 * release has one consumer.
 */
export const outboxCursor = mysqlTable('Outbox_Cursor', {
  consumer: varchar('consumer', { length: 32 }).notNull(),
  lastOutboxId: int('last_outbox_id').notNull(),
  updatedAt: stamp('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.consumer], name: 'Outbox_Cursor_consumer' }),
]);

/**
 * Sliding windows for the bot's own rate limits: one count per subject and
 * minute, summed over the last hour when a command arrives. The subject is
 * `user:` or `guild:` followed by the snowflake. Rows are pruned after ninety
 * days, and in practice after an hour.
 *
 * Bucket_start is the one datetime column in this database that holds UTC
 * rather than campus wall clock. A window is a duration, and a duration
 * cannot be measured on a clock that repeats an hour in November and skips
 * one in March. Nobody reads this column, so nothing is lost by keeping it on
 * a clock that only ever moves forward. See src/ratelimit/windows.ts.
 */
export const rateWindows = mysqlTable('Rate_Windows', {
  subject: varchar('subject', { length: 64 }).notNull(),
  bucketStart: datetime('bucket_start', { mode: 'string' }).notNull(),
  count: int('count').default(0).notNull(),
}, (table) => [
  primaryKey({ columns: [table.subject, table.bucketStart], name: 'Rate_Windows_subject_bucket_start' }),
  index('idx_rate_windows_bucket').on(table.bucketStart),
]);

/**
 * When each scheduled job last ran, on the campus clock.
 *
 * The digests, the reminders and the living message are jobs on an hourly
 * clock, and section 7 of the design asks that a bot which was down over a
 * digest hour sends the digest when it returns rather than skipping the week
 * or sending it twice. Skipping is what a job with no memory does, and sending
 * twice is what a job that remembers only within one process does, so the
 * memory is a row here. One row per job, replaced on every run.
 */
export const jobRuns = mysqlTable('Job_Runs', {
  jobName: varchar('job_name', { length: 64 }).notNull(),
  /** The campus hour the job last ran for, which is where a catch up resumes. */
  lastRunAt: datetime('last_run_at', { mode: 'string' }).notNull(),
  updatedAt: stamp('updated_at'),
}, (table) => [
  primaryKey({ columns: [table.jobName], name: 'Job_Runs_job_name' }),
]);
