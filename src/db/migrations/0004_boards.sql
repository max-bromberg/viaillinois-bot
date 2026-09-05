-- What a board does from Discord: the roles the bot itself gave out, the polls
-- the scheduler opened, and the board member a server was bound by.
--
-- Role_Grants is the whole of the rule that the bot never removes a role it did
-- not grant. A server hands the same roles out by hand as well, to an alumnus,
-- to somebody helping with one event, or to a person whose membership VIA has
-- not caught up with, and taking one of those away because VIA does not list
-- the person would be the bot overruling the server about its own roles. So the
-- bot writes a row here when it grants a role, and a role with no row here is
-- left alone for ever. The rows go with the server, which is what the cascade
-- from Guild_Installations is for.
--
-- Scheduler_Polls holds the two things Discord cannot hold about a poll: which
-- recommendation each answer stood for, so that the winning answer can be
-- turned back into a time and a room, and what was asked of the scheduler, so
-- that accepting can ask the same question again before anything is created.
-- Discord sends no event of its own when a poll ends, so closes_at is when the
-- bot goes and reads the result, and closed_at is what stops it posting that
-- result twice. Everything stored here was written by the bot, so none of it is
-- the text of anybody's message.
--
-- Guild_Installations.bound_by is the Discord account that bound the server to
-- its organization, which the web platform confirmed was on that organization's
-- board when it did so. The daily role reconciliation reads the organization's
-- members as that person, because reading members is board work on the web
-- platform and the bot has no identity of its own on VIA.

CREATE TABLE `Role_Grants` (
	`guild_id` varchar(32) NOT NULL,
	`discord_user_id` varchar(32) NOT NULL,
	`role_id` varchar(32) NOT NULL,
	`membership_role` enum('member','editor','board') NOT NULL,
	`granted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Role_Grants_guild_id_discord_user_id_role_id` PRIMARY KEY(`guild_id`,`discord_user_id`,`role_id`)
);
--> statement-breakpoint
CREATE TABLE `Scheduler_Polls` (
	`poll_id` int AUTO_INCREMENT NOT NULL,
	`guild_id` varchar(32) NOT NULL,
	`channel_id` varchar(32) NOT NULL,
	`message_id` varchar(32) NOT NULL,
	`rso_id` int NOT NULL,
	`opened_by` varchar(32) NOT NULL,
	`request` json NOT NULL,
	`candidates` json NOT NULL,
	`closes_at` datetime NOT NULL,
	`closed_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Scheduler_Polls_poll_id` PRIMARY KEY(`poll_id`),
	CONSTRAINT `uq_scheduler_poll_message` UNIQUE(`guild_id`,`message_id`)
);
--> statement-breakpoint
ALTER TABLE `Guild_Installations` ADD `bound_by` varchar(32);--> statement-breakpoint
ALTER TABLE `Role_Grants` ADD CONSTRAINT `Role_Grants_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `Scheduler_Polls` ADD CONSTRAINT `Scheduler_Polls_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_role_grants_guild` ON `Role_Grants` (`guild_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduler_polls_closes_at` ON `Scheduler_Polls` (`closes_at`);