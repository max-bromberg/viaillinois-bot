import { vi } from 'vitest';
import type { Interaction, PollDraft, Reply } from '../../src/discord/adapter.ts';
import type { CommandContext } from '../../src/commands/index.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import { featureById, type ChannelPurpose } from '../../src/features/registry.ts';
import type { RateDecision, RateTier } from '../../src/ratelimit/windows.ts';
import type {
  BindingChoice, GuildBinding, GuildInstallation, GuildKind, GuildMessage,
  GuildMessagePurpose, GuildStore, MappedRole, PostedMessageRef, RemovedRows,
} from '../../src/guilds/store.ts';
import type { FeedStore } from '../../src/feed/store.ts';
import { memoryFeedStore, memoryInterestMarks } from '../support/feed.ts';
import type { InterestMarks } from '../../src/feed/interestMarks.ts';

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
    installedInServer: true,
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
    boundBy: string | null;
    installedBy: string;
    digestDay: number;
    digestHour: number;
    reminderLeadMinutes: number;
    digestPinned: boolean;
  }>();
  const features = new Map<string, Map<string, boolean>>();
  const roleMappings = new Map<string, Map<MappedRole, string>>();
  const channels = new Map<string, Map<string, string>>();
  const followed = new Map<string, number[]>();
  const messages = new Map<string, GuildMessage>();
  const messageKey = (guildId: string, purpose: GuildMessagePurpose) => `${guildId}|${purpose}`;

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
      installations.set(guildId, {
        kind: null,
        binding: null,
        rsoId: null,
        boundBy: null,
        installedBy,
        digestDay: 0,
        digestHour: 18,
        reminderLeadMinutes: 60,
        digestPinned: false,
      });
    },
    async getInstallation(guildId) {
      const row = installations.get(guildId);
      if (!row) return null;
      const installation: GuildInstallation = {
        guildId,
        kind: row.kind,
        binding: row.binding,
        rsoId: row.rsoId,
        boundBy: row.boundBy,
        installedBy: row.installedBy,
        installedAt: '2026-09-05 09:00:00',
        mirrorWindowDays: 14,
        digestDay: row.digestDay,
        digestHour: row.digestHour,
        reminderLeadMinutes: row.reminderLeadMinutes,
        digestPinned: row.digestPinned,
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
      row.boundBy = choice.binding === 'rso' ? (choice.boundBy ?? null) : null;
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
    async listGuildsFollowing(rsoId) {
      const following: GuildInstallation[] = [];
      for (const [guildId, row] of installations) {
        if (row.kind === null) continue;
        const follows = (row.binding === 'rso' && row.rsoId === rsoId)
          || row.binding === 'all'
          || (row.binding === 'set' && (followed.get(guildId) ?? []).includes(rsoId));
        if (!follows) continue;
        following.push((await this.getInstallation(guildId))!);
      }
      return following;
    },
    async listInstallations() {
      const all: GuildInstallation[] = [];
      for (const [guildId, row] of installations) {
        if (row.kind === null || row.binding === null) continue;
        all.push((await this.getInstallation(guildId))!);
      }
      return all;
    },
    async setDigestSchedule(guildId, day, hour) {
      const row = installations.get(guildId);
      if (!row) return;
      row.digestDay = day;
      row.digestHour = hour;
    },
    async setReminderLeadMinutes(guildId, minutes) {
      const row = installations.get(guildId);
      if (row) row.reminderLeadMinutes = minutes;
    },
    async setDigestPinned(guildId, pinned) {
      const row = installations.get(guildId);
      if (row) row.digestPinned = pinned;
    },
    async listInstallationsForDigest(dayOfWeek, hour) {
      const due: GuildInstallation[] = [];
      for (const [guildId, row] of installations) {
        if (row.kind === null || row.binding === null) continue;
        if (row.digestDay !== dayOfWeek || row.digestHour !== hour) continue;
        due.push((await this.getInstallation(guildId))!);
      }
      return due;
    },
    async getGuildMessage(guildId, purpose) {
      return messages.get(messageKey(guildId, purpose)) ?? null;
    },
    async setGuildMessage(guildId, purpose, posted: PostedMessageRef) {
      messages.set(messageKey(guildId, purpose), { guildId, purpose, ...posted });
    },
    async listGuildMessages(guildId) {
      return [...messages.values()].filter(one => one.guildId === guildId);
    },
    async removeGuildMessage(guildId, purpose) {
      messages.delete(messageKey(guildId, purpose));
    },
    async setRoleMapping(guildId, membershipRole, roleId) {
      if (!roleMappings.has(guildId)) roleMappings.set(guildId, new Map());
      roleMappings.get(guildId)!.set(membershipRole, roleId);
    },
    async unsetRoleMapping(guildId, membershipRole) {
      roleMappings.get(guildId)?.delete(membershipRole);
    },
    async listRoleMappings(guildId) {
      return Object.fromEntries(roleMappings.get(guildId) ?? new Map()) as Partial<Record<MappedRole, string>>;
    },
    async removeGuild(guildId) {
      const removed: RemovedRows = {
        features: featuresOf(guildId).size,
        channels: channelsOf(guildId).size,
        followedRsos: (followed.get(guildId) ?? []).length,
        installation: installations.delete(guildId),
      };
      features.delete(guildId);
      roleMappings.delete(guildId);
      channels.delete(guildId);
      followed.delete(guildId);
      for (const held of [...messages.values()].filter(one => one.guildId === guildId)) {
        messages.delete(messageKey(held.guildId, held.purpose));
      }
      return removed;
    },
  };
}

export interface TestContext {
  context: CommandContext;
  via: FakeViaClient;
  /** Every message the context was asked to post into a channel, in order. */
  posted: Array<{ channelId: string; reply: Reply }>;
  /** Every poll the context was asked to open, in order. */
  pollsPosted: Array<{ channelId: string; poll: PollDraft }>;
  directMessages: Array<{ discordUserId: string; content: string }>;
  scheduled: Array<() => Promise<void>>;
  deleted: string[];
  consumed: Array<{ subject: string; tier: RateTier }>;
  guilds: GuildStore;
  feed: FeedStore;
  /** Who marked interest, which is what the feedback request the morning after reads. */
  marks: InterestMarks;
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
  feed?: FeedStore;
  marks?: InterestMarks;
} = {}): TestContext {
  const via = createFakeViaClient();
  const posted: Array<{ channelId: string; reply: Reply }> = [];
  const pollsPosted: Array<{ channelId: string; poll: PollDraft }> = [];
  const directMessages: Array<{ discordUserId: string; content: string }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  const deleted: string[] = [];
  const consumed: Array<{ subject: string; tier: RateTier }> = [];
  const guilds = options.guilds ?? memoryGuildStore();
  const feed = options.feed ?? memoryFeedStore();
  const marks = options.marks ?? memoryInterestMarks();
  let clock = new Date('2026-09-05T14:30:00Z');

  const context: CommandContext = {
    via,
    guilds,
    feed,
    interestMarks: marks,
    websiteUrl: 'https://viaillinois.com',
    rateWindows: {
      consume: async (subject: string, tier: RateTier) => {
        consumed.push({ subject, tier });
        return options.decide
          ? options.decide(subject, tier)
          : { allowed: true, used: 0, limit: 30, retryAfterSeconds: 0 };
      },
      sweep: async () => 0,
      pruneBefore: async () => 0,
    },
    deleteLocalData: vi.fn(async (discordUserId: string) => { deleted.push(discordUserId); }),
    sendDirectMessage: async (discordUserId: string, content: string) => {
      directMessages.push({ discordUserId, content });
    },
    postMessage: async (channelId: string, reply: Reply) => {
      posted.push({ channelId, reply });
      return '800000000000000001';
    },
    postPoll: async (channelId: string, poll: PollDraft) => {
      pollsPosted.push({ channelId, poll });
      return '800000000000000001';
    },
    schedule: (task: () => Promise<void>) => { scheduled.push(task); },
    now: () => clock,
    sleep: async (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
  };

  return {
    context, via, guilds, feed, marks, posted, pollsPosted, directMessages, scheduled, deleted,
    consumed, clockAt: () => clock,
  };
}
