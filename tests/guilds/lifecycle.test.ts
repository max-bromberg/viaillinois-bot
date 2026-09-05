import { describe, it, expect } from 'vitest';
import { toGuild } from '../../src/discord/adapter.ts';
import { createGuildLifecycle } from '../../src/guilds/lifecycle.ts';
import type { GuildStore, GuildInstallation, RemovedRows } from '../../src/guilds/store.ts';

/**
 * What the bot does when it joins a server and when it leaves one.
 *
 * Joining writes one row that says the server has not been set up, and
 * nothing else: no channel is bound, no feature is switched on beyond the
 * registry defaults, and nothing is posted. Leaving deletes every row for the
 * server, which is what removal does through the command and what being
 * kicked has to do through the gateway.
 *
 * The events are built by hand in the shape the library hands over, and read
 * through the adapter, so this suite needs no gateway.
 */

/** A store that records what it was asked, with no database behind it. */
function recordingStore() {
  const created: Array<{ guildId: string; installedBy: string }> = [];
  const removed: string[] = [];
  const store: GuildStore = {
    async createInstallation(guildId, installedBy) { created.push({ guildId, installedBy }); },
    async getInstallation() { return null as GuildInstallation | null; },
    async setKind() {},
    async setBinding() {},
    async isFeatureEnabled() { return true; },
    async setFeatureEnabled() {},
    async listFeatureChanges() { return {}; },
    async bindChannel() {},
    async unbindChannel() {},
    async listChannels() { return {}; },
    async setFollowedRsos() {},
    async listFollowedRsos() { return []; },
    async listGuildsFollowing() { return []; },
    async listInstallations() { return []; },
    async removeGuild(guildId) {
      removed.push(guildId);
      return { features: 0, channels: 0, followedRsos: 0, installation: true } as RemovedRows;
    },
  };
  return { store, created, removed };
}

function guildEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '900000000000000001',
    name: 'IEEE at Illinois',
    ownerId: '204255221017214977',
    available: true,
    ...overrides,
  };
}

describe('reading a server the gateway announced', () => {
  it('reads a guild into a plain object', () => {
    expect(toGuild(guildEvent() as never)).toEqual({
      id: '900000000000000001',
      name: 'IEEE at Illinois',
      ownerId: '204255221017214977',
      available: true,
    });
  });

  it('treats a guild the library said nothing about as available, as the library does', () => {
    expect(toGuild({ id: '900000000000000001', ownerId: '204255221017214977' } as never).available).toBe(true);
  });
});

describe('joining and leaving a server', () => {
  it('records a server the bot has just joined, as one that is not set up', async () => {
    const { store, created } = recordingStore();
    await createGuildLifecycle({ guilds: store }).onGuildCreate(guildEvent() as never);
    expect(created).toEqual([{ guildId: '900000000000000001', installedBy: '204255221017214977' }]);
  });

  it('records every server the gateway announces on a reconnection, without changing any', async () => {
    const { store, created } = recordingStore();
    const lifecycle = createGuildLifecycle({ guilds: store });
    await lifecycle.onGuildCreate(guildEvent() as never);
    await lifecycle.onGuildCreate(guildEvent() as never);
    expect(created).toHaveLength(2);
  });

  it('deletes every row for a server the bot was removed from', async () => {
    const { store, removed } = recordingStore();
    await createGuildLifecycle({ guilds: store }).onGuildDelete(guildEvent() as never);
    expect(removed).toEqual(['900000000000000001']);
  });

  /**
   * Discord sends the same event for a server that has gone down as for a
   * server the bot was removed from, and tells them apart with one flag. A bot
   * that deleted a server's setup because Discord had an outage would be a bot
   * every server had to set up twice.
   */
  it('keeps everything for a server that is only unavailable', async () => {
    const { store, removed } = recordingStore();
    await createGuildLifecycle({ guilds: store }).onGuildDelete(guildEvent({ available: false }) as never);
    expect(removed).toEqual([]);
  });

  it('does not let one server failing take the gateway down with it', async () => {
    const failing: GuildStore = {
      ...recordingStore().store,
      createInstallation: async () => { throw new Error('the database fell over'); },
    };
    await expect(createGuildLifecycle({ guilds: failing }).onGuildCreate(guildEvent() as never))
      .resolves.toBeUndefined();
  });
});
