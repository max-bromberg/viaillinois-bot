import { toGuild } from '../discord/adapter.ts';
import type { GuildStore } from './store.ts';

/**
 * What the bot does when it joins a server and when it leaves one.
 *
 * Joining writes one row saying that the server exists and has not been set
 * up, and does nothing else. The design is explicit about this: read commands
 * are on, nothing else is, no channel is bound, and nothing is posted until a
 * server manager has run setup. A bot that starts posting the moment it is
 * invited is a bot that gets removed.
 *
 * Leaving deletes every row the bot holds for the server, which is the same
 * thing the removal command does, because being kicked and being removed are
 * the same intention expressed two ways. What is not deleted is anything
 * belonging to the people who used the bot there: their links, subscriptions
 * and preferences are theirs rather than the server's.
 */

export interface GuildLifecycleOptions {
  guilds: GuildStore;
}

export interface GuildLifecycle {
  onGuildCreate(raw: unknown): Promise<void>;
  onGuildDelete(raw: unknown): Promise<void>;
}

export function createGuildLifecycle({ guilds }: GuildLifecycleOptions): GuildLifecycle {
  return {
    /**
     * The gateway announces every server the bot is in on every connection, so
     * this runs for servers that have been set up for months as well as for
     * one just joined. The store's insert leaves an existing row alone, so a
     * reconnection changes nothing.
     *
     * The event names the server's owner and does not name whoever invited the
     * bot, so the owner is what is recorded. The manager who actually sets the
     * bot up is a separate question, answered when setup runs.
     */
    async onGuildCreate(raw: unknown): Promise<void> {
      const guild = toGuild(raw);
      try {
        await guilds.createInstallation(guild.id, guild.ownerId);
      } catch (err) {
        console.error(`recording the server ${guild.id} failed:`, (err as Error).message);
      }
    },

    /**
     * Discord sends this event both for a server the bot was removed from and
     * for a server that has gone down, and tells them apart with one flag. A
     * bot that deleted a server's whole setup because Discord had an outage
     * would be a bot every server had to set up twice, so an unavailable
     * server is left exactly as it was.
     */
    async onGuildDelete(raw: unknown): Promise<void> {
      const guild = toGuild(raw);
      if (!guild.available) return;
      try {
        await guilds.removeGuild(guild.id);
      } catch (err) {
        console.error(`removing the server ${guild.id} failed:`, (err as Error).message);
      }
    },
  };
}
