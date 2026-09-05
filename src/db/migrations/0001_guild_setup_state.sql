-- A server that has just installed the bot has not been set up yet, and the two
-- columns that say what a server is have to be able to say that it has not been
-- answered for. Before this migration both were required, so the gateway had no
-- honest row to write when the bot joined a server: any value it chose would have
-- read back as an answer a manager gave, and the design says that nothing is
-- posted and no channel is touched until a manager has actually run setup.
--
-- Both columns therefore become nullable, and null means that setup has not
-- reached that question. No row exists in any deployed database yet, because the
-- bot has not been released, so nothing is being made nullable underneath data
-- that relied on it. See src/guilds/store.ts, whose isSetUp answer is exactly the
-- claim that neither column is null.
ALTER TABLE `Guild_Installations` MODIFY COLUMN `kind` enum('rso','community');--> statement-breakpoint
ALTER TABLE `Guild_Installations` MODIFY COLUMN `binding` enum('rso','all','set');
