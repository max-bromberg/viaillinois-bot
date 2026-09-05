-- What a server chose about its timed posts, and the two messages the bot has
-- to be able to find again.
--
-- The weekly digest and the day of reminders happen at a time the server
-- chooses, so the four settings live beside the rest of that server's answers
-- in Guild_Installations rather than in a table of their own. The defaults are
-- the ones the setup panel offers, Sunday at six in the evening and an hour of
-- notice, so a server that switches the digest on without opening the timing
-- panel still posts at a sensible hour rather than at midnight.
--
-- Guild_Messages is for the two messages that are about a week rather than
-- about an event: the living this week message, which the bot edits in place
-- and keeps pinned, and the last digest, which it unpins when it pins the next
-- one. Event_Mirrors answers the same question for events, and neither table
-- can answer the other's, because there is at most one of each of these per
-- server and there is one mirror per event.
CREATE TABLE `Guild_Messages` (
	`guild_id` varchar(32) NOT NULL,
	`purpose` varchar(32) NOT NULL,
	`channel_id` varchar(32) NOT NULL,
	`message_id` varchar(32) NOT NULL,
	`posted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Guild_Messages_guild_id_purpose` PRIMARY KEY(`guild_id`,`purpose`)
);
--> statement-breakpoint
ALTER TABLE `Guild_Installations` ADD `digest_day` tinyint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `Guild_Installations` ADD `digest_hour` tinyint DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE `Guild_Installations` ADD `reminder_lead_minutes` int DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `Guild_Installations` ADD `digest_pinned` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `Guild_Messages` ADD CONSTRAINT `Guild_Messages_guild_id_Guild_Installations_guild_id_fk` FOREIGN KEY (`guild_id`) REFERENCES `Guild_Installations`(`guild_id`) ON DELETE cascade ON UPDATE no action;