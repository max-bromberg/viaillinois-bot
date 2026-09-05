import { and, eq } from 'drizzle-orm';
import { guildChannels, guildFeatures, guildFollowedRsos, guildInstallations } from '../db/schema.ts';
import { featureById, type ChannelPurpose } from '../features/registry.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * The server records.
 *
 * Four tables answer one question each. Guild_Installations says what a
 * server is and what it speaks for, Guild_Followed_Rsos spells out the set
 * when the binding is a set, Guild_Features holds the toggles a server moved
 * away from the registry default, and Guild_Channels holds the channel a
 * server bound to each purpose. Everything the setup panels write and
 * everything the proactive jobs read goes through this module, so there is
 * one place that knows the shape of a server's configuration.
 *
 * The state that matters most here is the state a server is in before it has
 * been set up. The bot joins a server the moment somebody invites it, and at
 * that moment nobody has said whether the server belongs to one organization
 * or to the wider community, or which organizations it cares about. That is
 * recorded as null in both columns rather than as a value nobody chose,
 * because the design turns on the difference: nothing is posted, no scheduled
 * event is created and no role is touched until a manager has answered.
 */

/** What kind of server this is, as the setup panel asks it. */
export type GuildKind = 'rso' | 'community';

/** What the server speaks for: one organization, all of ECE, or a chosen set. */
export type GuildBinding = 'rso' | 'all' | 'set';

export interface GuildInstallation {
  guildId: string;
  /** Null until a manager has said what kind of server this is. */
  kind: GuildKind | null;
  /** Null until a manager has said what the server is bound to. */
  binding: GuildBinding | null;
  /** The one organization, when the binding names one. */
  rsoId: number | null;
  installedBy: string;
  installedAt: string;
  mirrorWindowDays: number;
  /** Whether setup has answered both of the questions that define a server. */
  isSetUp: boolean;
}

/** What a binding is being set to, with the organization when it names one. */
export interface BindingChoice {
  binding: GuildBinding;
  rsoId?: number | null;
}

/** How many rows removal deleted, so that the manager is told what went. */
export interface RemovedRows {
  features: number;
  channels: number;
  followedRsos: number;
  installation: boolean;
}

export interface GuildStore {
  /** Record a server the bot has just joined, leaving setup unanswered. */
  createInstallation(guildId: string, installedBy: string): Promise<void>;
  getInstallation(guildId: string): Promise<GuildInstallation | null>;
  setKind(guildId: string, kind: GuildKind): Promise<void>;
  setBinding(guildId: string, choice: BindingChoice): Promise<void>;
  /** Whether a feature is on here, which is the registry default until a server changes it. */
  isFeatureEnabled(guildId: string, featureId: string): Promise<boolean>;
  setFeatureEnabled(guildId: string, featureId: string, enabled: boolean): Promise<void>;
  /** Only the features this server moved away from the default, by identifier. */
  listFeatureChanges(guildId: string): Promise<Record<string, boolean>>;
  bindChannel(guildId: string, purpose: ChannelPurpose, channelId: string): Promise<void>;
  unbindChannel(guildId: string, purpose: ChannelPurpose): Promise<void>;
  listChannels(guildId: string): Promise<Partial<Record<ChannelPurpose, string>>>;
  /** Replace the followed set, which is what the multiple choice panel writes. */
  setFollowedRsos(guildId: string, rsoIds: readonly number[]): Promise<void>;
  listFollowedRsos(guildId: string): Promise<number[]>;
  /** Delete every row the bot holds for a server, and say what it deleted. */
  removeGuild(guildId: string): Promise<RemovedRows>;
}

function present(row: typeof guildInstallations.$inferSelect): GuildInstallation {
  return {
    guildId: row.guildId,
    kind: row.kind ?? null,
    binding: row.binding ?? null,
    rsoId: row.rsoId ?? null,
    installedBy: row.installedBy,
    installedAt: row.installedAt,
    mirrorWindowDays: row.mirrorWindowDays,
    isSetUp: row.kind !== null && row.binding !== null,
  };
}

export function createGuildStore(db: BotDatabase): GuildStore {
  return {
    /**
     * The gateway announces every server the bot is in on every connection,
     * not only the ones it has just joined, so this has to be safe to run
     * again. An insert that does nothing when the row is there keeps the
     * first manager and the first answers rather than overwriting them with
     * the state of a reconnection.
     */
    async createInstallation(guildId, installedBy) {
      await db.insert(guildInstallations)
        .values({ guildId, installedBy })
        .onDuplicateKeyUpdate({ set: { guildId } });
    },

    async getInstallation(guildId) {
      const [row] = await db.select().from(guildInstallations)
        .where(eq(guildInstallations.guildId, guildId));
      return row ? present(row) : null;
    },

    async setKind(guildId, kind) {
      await db.update(guildInstallations).set({ kind })
        .where(eq(guildInstallations.guildId, guildId));
    },

    /**
     * A binding that does not name an organization clears the one that was
     * named before it, so a server that moved from one organization to all of
     * ECE does not keep a stale identifier that a later reading would trust.
     */
    async setBinding(guildId, choice) {
      await db.update(guildInstallations)
        .set({ binding: choice.binding, rsoId: choice.binding === 'rso' ? (choice.rsoId ?? null) : null })
        .where(eq(guildInstallations.guildId, guildId));
    },

    async isFeatureEnabled(guildId, featureId) {
      // The lookup comes first so that an identifier the registry does not
      // have is a mistake in the bot rather than a silent false.
      const feature = featureById(featureId);
      const [row] = await db.select().from(guildFeatures)
        .where(and(eq(guildFeatures.guildId, guildId), eq(guildFeatures.featureId, featureId)));
      return row ? Boolean(row.enabled) : feature.defaultEnabled;
    },

    async setFeatureEnabled(guildId, featureId, enabled) {
      featureById(featureId);
      await db.insert(guildFeatures)
        .values({ guildId, featureId, enabled })
        .onDuplicateKeyUpdate({ set: { enabled } });
    },

    async listFeatureChanges(guildId) {
      const rows = await db.select().from(guildFeatures)
        .where(eq(guildFeatures.guildId, guildId));
      const changes: Record<string, boolean> = {};
      for (const row of rows) changes[row.featureId] = Boolean(row.enabled);
      return changes;
    },

    async bindChannel(guildId, purpose, channelId) {
      await db.insert(guildChannels)
        .values({ guildId, purpose, channelId })
        .onDuplicateKeyUpdate({ set: { channelId } });
    },

    async unbindChannel(guildId, purpose) {
      await db.delete(guildChannels)
        .where(and(eq(guildChannels.guildId, guildId), eq(guildChannels.purpose, purpose)));
    },

    async listChannels(guildId) {
      const rows = await db.select().from(guildChannels)
        .where(eq(guildChannels.guildId, guildId));
      const bound: Partial<Record<ChannelPurpose, string>> = {};
      for (const row of rows) bound[row.purpose as ChannelPurpose] = row.channelId;
      return bound;
    },

    /**
     * The set is replaced rather than added to, because the panel it comes
     * from shows the whole set and a manager who unticks an organization is
     * saying that it is no longer in the set.
     */
    async setFollowedRsos(guildId, rsoIds) {
      const wanted = [...new Set(rsoIds)];
      await db.delete(guildFollowedRsos).where(eq(guildFollowedRsos.guildId, guildId));
      if (wanted.length === 0) return;
      await db.insert(guildFollowedRsos).values(wanted.map(rsoId => ({ guildId, rsoId })));
    },

    async listFollowedRsos(guildId) {
      const rows = await db.select().from(guildFollowedRsos)
        .where(eq(guildFollowedRsos.guildId, guildId));
      return rows.map(row => row.rsoId).sort((a, b) => a - b);
    },

    /**
     * Removal counts before it deletes, because the manager is told what went
     * and a count taken afterwards would be zero whatever was there. The three
     * dependent tables cascade from the installation row, and they are deleted
     * here as well so that the count and the delete cannot disagree.
     */
    async removeGuild(guildId) {
      const [features, channels, followed, installation] = await Promise.all([
        db.select().from(guildFeatures).where(eq(guildFeatures.guildId, guildId)),
        db.select().from(guildChannels).where(eq(guildChannels.guildId, guildId)),
        db.select().from(guildFollowedRsos).where(eq(guildFollowedRsos.guildId, guildId)),
        db.select().from(guildInstallations).where(eq(guildInstallations.guildId, guildId)),
      ]);

      await db.delete(guildFeatures).where(eq(guildFeatures.guildId, guildId));
      await db.delete(guildChannels).where(eq(guildChannels.guildId, guildId));
      await db.delete(guildFollowedRsos).where(eq(guildFollowedRsos.guildId, guildId));
      await db.delete(guildInstallations).where(eq(guildInstallations.guildId, guildId));

      return {
        features: features.length,
        channels: channels.length,
        followedRsos: followed.length,
        installation: installation.length > 0,
      };
    },
  };
}
