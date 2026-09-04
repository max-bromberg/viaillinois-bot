-- Baseline schema for the bot database, via_bot, generated from src/db/schema.ts with
-- drizzle-kit on 2026-09-04. This database is new, so unlike the web platform's baseline
-- nothing is stamped: a fresh database is built by running the migrations from here.
-- Every later change to the schema is a further migration in this directory, and the
-- drift check in the gate refuses a schema declaration that has no migration.
CREATE TABLE `Deliveries` (
	`delivery_id` int AUTO_INCREMENT NOT NULL,
	`outbox_id` int NOT NULL,
	`target` varchar(64) NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`kind` enum('message','edit','direct_message','scheduled_event') NOT NULL,
	`message_id` varchar(32),
	`intended_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`delivered_at` datetime,
	CONSTRAINT `Deliveries_delivery_id` PRIMARY KEY(`delivery_id`),
	CONSTRAINT `uq_delivery` UNIQUE(`outbox_id`,`target`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `Event_Mirrors` (
	`mirror_id` int AUTO_INCREMENT NOT NULL,
	`guild_id` varchar(32) NOT NULL,
	`event_id` int NOT NULL,
	`scheduled_event_id` varchar(32),
	`announcement_channel_id` varchar(32),
	`announcement_message_id` varchar(32),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Event_Mirrors_mirror_id` PRIMARY KEY(`mirror_id`),
	CONSTRAINT `uq_event_mirror` UNIQUE(`guild_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `Guild_Channels` (
	`guild_id` varchar(32) NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`channel_id` varchar(32) NOT NULL,
	CONSTRAINT `Guild_Channels_guild_id_purpose` PRIMARY KEY(`guild_id`,`purpose`)
);
--> statement-breakpoint
CREATE TABLE `Guild_Features` (
	`guild_id` varchar(32) NOT NULL,
	`feature_id` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Guild_Features_guild_id_feature_id` PRIMARY KEY(`guild_id`,`feature_id`)
);
--> statement-breakpoint
CREATE TABLE `Guild_Followed_Rsos` (
	`guild_id` varchar(32) NOT NULL,
	`rso_id` int NOT NULL,
	CONSTRAINT `Guild_Followed_Rsos_guild_id_rso_id` PRIMARY KEY(`guild_id`,`rso_id`)
);
--> statement-breakpoint
CREATE TABLE `Guild_Installations` (
	`guild_id` varchar(32) NOT NULL,
	`kind` enum('rso','community') NOT NULL,
	`binding` enum('rso','all','set') NOT NULL,
	`rso_id` int,
	`installed_by` varchar(32) NOT NULL,
	`installed_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`mirror_window_days` int NOT NULL DEFAULT 14,
	CONSTRAINT `Guild_Installations_guild_id` PRIMARY KEY(`guild_id`)
);
--> statement-breakpoint
CREATE TABLE `Guild_Role_Mappings` (
	`guild_id` varchar(32) NOT NULL,
	`membership_role` enum('member','editor','board') NOT NULL,
	`role_id` varchar(32) NOT NULL,
	CONSTRAINT `Guild_Role_Mappings_guild_id_membership_role` PRIMARY KEY(`guild_id`,`membership_role`)
);
--> statement-breakpoint
CREATE TABLE `Outbox_Cursor` (
	`consumer` varchar(32) NOT NULL,
	`last_outbox_id` int NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Outbox_Cursor_consumer` PRIMARY KEY(`consumer`)
);
--> statement-breakpoint
CREATE TABLE `Rate_Windows` (
	`subject` varchar(64) NOT NULL,
	`bucket_start` datetime NOT NULL,
	`count` int NOT NULL DEFAULT 0,
	CONSTRAINT `Rate_Windows_subject_bucket_start` PRIMARY KEY(`subject`,`bucket_start`)
);
--> statement-breakpoint
CREATE TABLE `Reminders` (
	`reminder_id` int AUTO_INCREMENT NOT NULL,
	`discord_user_id` varchar(32) NOT NULL,
	`event_id` int NOT NULL,
	`remind_at` datetime NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Reminders_reminder_id` PRIMARY KEY(`reminder_id`),
	CONSTRAINT `uq_reminder` UNIQUE(`discord_user_id`,`event_id`)
);
--> statement-breakpoint
CREATE TABLE `Subscriptions` (
	`discord_user_id` varchar(32) NOT NULL,
	`rso_id` int NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Subscriptions_discord_user_id_rso_id` PRIMARY KEY(`discord_user_id`,`rso_id`)
);
--> statement-breakpoint
CREATE TABLE `User_Courses` (
	`discord_user_id` varchar(32) NOT NULL,
	`course_code` varchar(20) NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `User_Courses_discord_user_id_course_code` PRIMARY KEY(`discord_user_id`,`course_code`)
);
--> statement-breakpoint
CREATE TABLE `User_Preferences` (
	`discord_user_id` varchar(32) NOT NULL,
	`digest_day` tinyint,
	`digest_hour` tinyint,
	`reminder_lead_minutes` int NOT NULL DEFAULT 60,
	`follow_all` boolean NOT NULL DEFAULT false,
	`feedback_opt_out` boolean NOT NULL DEFAULT false,
	`direct_message_opt_out` boolean NOT NULL DEFAULT false,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `User_Preferences_discord_user_id` PRIMARY KEY(`discord_user_id`)
);
--> statement-breakpoint
ALTER TABLE `Event_Mirrors` ADD CONSTRAINT `Event_Mirrors_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Guild_Channels` ADD CONSTRAINT `Guild_Channels_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Guild_Features` ADD CONSTRAINT `Guild_Features_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Guild_Followed_Rsos` ADD CONSTRAINT `Guild_Followed_Rsos_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Guild_Role_Mappings` ADD CONSTRAINT `Guild_Role_Mappings_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_deliveries_intended_at` ON `Deliveries` (`intended_at`);--> statement-breakpoint
CREATE INDEX `idx_event_mirrors_event` ON `Event_Mirrors` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_rate_windows_bucket` ON `Rate_Windows` (`bucket_start`);--> statement-breakpoint
CREATE INDEX `idx_reminders_remind_at` ON `Reminders` (`remind_at`);