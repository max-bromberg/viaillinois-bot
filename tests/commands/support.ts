import { vi } from 'vitest';
import type { Interaction } from '../../src/discord/adapter.ts';
import type { CommandContext } from '../../src/commands/index.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { featureById, type ChannelPurpose } from '../../src/features/registry.ts';
import type { RateDecision, RateTier } from '../../src/ratelimit/windows.ts';
import type {
  BindingChoice, GuildBinding, GuildInstallation, GuildKind, GuildStore, RemovedRows,
} from '../../src/guilds/store.ts';

/** A plain interaction in the shape the adapter hands to a command. */
export function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    kind: 'chatCommand',
    id: '111111111111111111',
    commandName: 'link',
    options: {},
    customId: null,
    values: [],
    fields: {},
    focusedOption: null,
    userId: '204255221017214977',
    guildId: '900000000000000001',
    channelId: '900000000000000002',
    context: 'guild',
    memberPermissions: [],
    applicationPermissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'],
    ...overrides,
  };
}

/**
 * The server records, in memory. The store's own guarantees are tested
 * against a real database in tests/db/guildStore.db.test.ts, so what the
 * command tests need from it is behaviour rather than persistence: the
 * registry default for a feature nobody changed, and rows that go away when
 * a server is removed.
 */
export function memoryGuildStore(): GuildStore {
  const installations = new Map<string, {
    kind: GuildKind | null;
    binding: GuildBinding | null;
    rsoId: number | null;
    installedBy: string;
  }>();
  const features = new Map<string, Map<string, boolean>>();
  const channels = new Map<string, Map<string, string>>();
  const followed = new Map<string, number[]>();

  const featuresOf = (guildId: string) => {
    if (!features.has(guildId)) features.set(guildId, new Map());
    return features.get(guildId)!;
  };
  const channelsOf = (guildId: string) => {
    if (!channels.has(guildId)) channels.set(guildId, new Map());
    return channels.get(guildId)!;
  };

  return {
    async createInstallation(guildId, installedBy) {
      if (installations.has(guildId)) return;
      installations.set(guildId, { kind: null, binding: null, rsoId: null, installedBy });
    },
    async getInstallation(guildId) {
      const row = installations.get(guildId);
      if (!row) return null;
      const installation: GuildInstallation = {
        guildId,
        kind: row.kind,
        binding: row.binding,
        rsoId: row.rsoId,
        installedBy: row.installedBy,
        installedAt: '2026-09-05 09:00:00',
        mirrorWindowDays: 14,
        isSetUp: row.kind !== null && row.binding !== null,
      };
      return installation;
    },
    async setKind(guildId, kind) {
      const row = installations.get(guildId);
      if (row) row.kind = kind;
    },
    async setBinding(guildId, choice: BindingChoice) {
      const row = installations.get(guildId);
      if (!row) return;
      row.binding = choice.binding;
      row.rsoId = choice.binding === 'rso' ? (choice.rsoId ?? null) : null;
    },
    async isFeatureEnabled(guildId, featureId) {
      const held = featuresOf(guildId).get(featureId);
      return held === undefined ? featureById(featureId).defaultEnabled : held;
    },
    async setFeatureEnabled(guildId, featureId, enabled) {
      featureById(featureId);
      featuresOf(guildId).set(featureId, enabled);
    },
    async listFeatureChanges(guildId) {
      return Object.fromEntries(featuresOf(guildId));
    },
    async bindChannel(guildId, purpose, channelId) {
      channelsOf(guildId).set(purpose, channelId);
    },
    async unbindChannel(guildId, purpose) {
      channelsOf(guildId).delete(purpose);
    },
    async listChannels(guildId) {
      return Object.fromEntries(channelsOf(guildId)) as Partial<Record<ChannelPurpose, string>>;
    },
    async setFollowedRsos(guildId, rsoIds) {
      followed.set(guildId, [...new Set(rsoIds)].sort((a, b) => a - b));
    },
    async listFollowedRsos(guildId) {
      return [...(followed.get(guildId) ?? [])];
    },
    async removeGuild(guildId) {
      const removed: RemovedRows = {
        features: featuresOf(guildId).size,
        channels: channelsOf(guildId).size,
        followedRsos: (followed.get(guildId) ?? []).length,
        installation: installations.delete(guildId),
      };
      features.delete(guildId);
      channels.delete(guildId);
      followed.delete(guildId);
      return removed;
    },
  };
}

export interface TestContext {
  context: CommandContext;
  via: FakeViaClient;
  directMessages: Array<{ discordUserId: string; content: string }>;
  scheduled: Array<() => Promise<void>>;
  deleted: string[];
  consumed: Array<{ subject: string; tier: RateTier }>;
  guilds: GuildStore;
  /** The fake clock, which the fake sleep moves forward. */
  clockAt: () => Date;
}

/**
 * A command context with nothing real behind it: the fake web platform
 * client, a recorded direct message sender, a rate limiter that allows
 * everything unless a test says otherwise, and a clock the fake sleep moves
 * rather than a timer anybody waits on.
 */
export function testContext(options: {
  decide?: (subject: string, tier: RateTier) => RateDecision;
  guilds?: GuildStore;
} = {}): TestContext {
  const via = createFakeViaClient();
  const directMessages: Array<{ discordUserId: string; content: string }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  const deleted: string[] = [];
  const consumed: Array<{ subject: string; tier: RateTier }> = [];
  const guilds = options.guilds ?? memoryGuildStore();
  let clock = new Date('2026-09-05T14:30:00Z');

  const context: CommandContext = {
    via,
    guilds,
    websiteUrl: 'https://viaillinois.com',
    rateWindows: {
      consume: async (subject: string, tier: RateTier) => {
        consumed.push({ subject, tier });
        return options.decide
          ? options.decide(subject, tier)
          : { allowed: true, used: 0, limit: 30, retryAfterSeconds: 0 };
      },
      sweep: async () => 0,
    },
    deleteLocalData: vi.fn(async (discordUserId: string) => { deleted.push(discordUserId); }),
    sendDirectMessage: async (discordUserId: string, content: string) => {
      directMessages.push({ discordUserId, content });
    },
    schedule: (task: () => Promise<void>) => { scheduled.push(task); },
    now: () => clock,
    sleep: async (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
  };

  return { context, via, guilds, directMessages, scheduled, deleted, consumed, clockAt: () => clock };
}
