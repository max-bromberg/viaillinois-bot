import type { LinkedAccount, ViaClient } from '../via/client.ts';

/**
 * Who a NetID is, for as long as the bot is answering.
 *
 * The bot never stores a NetID. Section 7 of the design is explicit about it:
 * the bot holds Discord identifiers and VIA identifiers and nothing else that
 * identifies a person, and when it needs to know who a Discord user is it asks
 * the web platform and caches the answer briefly in memory.
 *
 * Membership entries name a person by NetID, because that is who VIA is about,
 * and a Discord role has to be given to a Discord account. This is the one
 * place that bridges the two, and it is a map in memory with a lifetime rather
 * than a table: it is filled by the link lookups the bot already makes, it is
 * gone when the process is, and a person it cannot name is skipped and left to
 * the daily reconciliation rather than guessed at.
 */

/** How long an entry is trusted, after which the bot asks again. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface NetIdDirectoryOptions {
  now?: () => Date;
  ttlMs?: number;
}

export interface NetIdDirectory {
  /** Write down who a resolved link names, which every lookup does. */
  remember(link: LinkedAccount): void;
  /** The Discord account a NetID belongs to, or null when the bot cannot say. */
  discordUserFor(netId: string): string | null;
  /** Forget one account, which unlinking does. */
  forget(discordUserId: string): void;
  /** How many entries are held, which the health endpoint could report. */
  size(): number;
}

export function createNetIdDirectory(options: NetIdDirectoryOptions = {}): NetIdDirectory {
  const { now = () => new Date(), ttlMs = DEFAULT_TTL_MS } = options;
  const held = new Map<string, { discordUserId: string; expiresAt: number }>();

  return {
    remember(link) {
      if (!link.netId || !link.discordUserId) return;
      held.set(link.netId, {
        discordUserId: link.discordUserId,
        expiresAt: now().getTime() + ttlMs,
      });
    },

    discordUserFor(netId) {
      const entry = held.get(netId);
      if (!entry) return null;
      if (entry.expiresAt <= now().getTime()) {
        held.delete(netId);
        return null;
      }
      return entry.discordUserId;
    },

    forget(discordUserId) {
      for (const [netId, entry] of held) {
        if (entry.discordUserId === discordUserId) held.delete(netId);
      }
    },

    size: () => held.size,
  };
}

/**
 * The web platform client, filling the directory as it goes.
 *
 * Every place in the bot that resolves a link already calls getLink, so this
 * wrapper is what makes the directory fill itself: the answers the bot was
 * going to ask for anyway are what it learns from, and no lookup is made for
 * the sake of the directory alone.
 */
export function withNetIdDirectory<T extends ViaClient>(inner: T, directory: NetIdDirectory): T {
  return {
    ...inner,
    async getLink(discordUserId: string) {
      const link = await inner.getLink(discordUserId);
      if (link) directory.remember(link);
      return link;
    },
    async unlink(discordUserId: string) {
      const removed = await inner.unlink(discordUserId);
      if (removed) directory.forget(discordUserId);
      return removed;
    },
  };
}
