-- Who marked interest in an event, which is who the feedback request goes to.
--
-- Section 6.4 of the design asks the people who marked interest in an event,
-- or who asked to be reminded of it, what they thought of it, in one direct
-- message the morning after. The people who asked to be reminded are already
-- written down, in Reminders. The people who marked interest are not: interest
-- is recorded on the web platform, which holds it by NetID for a linked person
-- and by a salted hash of the Discord identifier for everybody else, and
-- neither of those can be turned back into a Discord account to write to.
--
-- Section 7 says the bot stores Discord identifiers and VIA identifiers and
-- nothing that identifies a person beyond those, and that it never stores a
-- NetID. So this table is the bot's own record of the marks it forwarded: one
-- row per event and Discord account, written where interest is sent to the web
-- platform and deleted when interest is withdrawn. It holds two identifiers and
-- the moment, and nothing else.
--
-- The rows for an event go once the feedback for it has been asked for, and the
-- rows of a person go when they unlink, along with every other row the bot held
-- for that account.

CREATE TABLE `Interest_Marks` (
	`event_id` int NOT NULL,
	`discord_user_id` varchar(32) NOT NULL,
	`marked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `Interest_Marks_event_id_discord_user_id` PRIMARY KEY(`event_id`,`discord_user_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_interest_marks_user` ON `Interest_Marks` (`discord_user_id`);