import {
  mysqlTable, primaryKey, unique, index, int, varchar, tinyint, boolean, datetime, mysqlEnum,
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
