import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import {
  guildChannels, guildFeatures, guildFollowedRsos, guildInstallations, guildMessages,
  guildRoleMappings,
} from '../db/schema.ts';
import { featureById, type ChannelPurpose } from '../features/registry.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * The server records.
 *
 * Five tables answer one question each. Guild_Installations says what a
 * server is, what it speaks for and when its timed posts happen,
 * Guild_Followed_Rsos spells out the set when the binding is a set,
 * Guild_Features holds the toggles a server moved away from the registry
 * default, Guild_Channels holds the channel a server bound to each purpose,
 * and Guild_Messages holds the two messages the bot has to be able to find
 * again, which are the living this week message and the last digest. Everything the setup panels write and
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

/**
 * The three VIA membership roles a server can map a Discord role to. The web
 * platform also has a global administrator, which is not a membership of any
 * organization and is therefore not something a server maps.
 */
export const MAPPED_ROLES = ['member', 'editor', 'board'] as const;
export type MappedRole = (typeof MAPPED_ROLES)[number];

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
  /** The day of the week the weekly digest is posted on, zero for Sunday. */
  digestDay: number;
  /** The hour on the campus clock the weekly digest is posted at. */
  digestHour: number;
  /** How far ahead the day of reminders are posted. */
  reminderLeadMinutes: number;
  /** Whether each digest is pinned and the one before it unpinned. */
  digestPinned: boolean;
  /**
   * The Discord account that bound this server to its organization, which the
   * web platform confirmed was on that organization's board at the time. The
   * daily role reconciliation reads the organization's members as this person,
   * because reading members is board work and the bot has no identity of its
   * own on VIA. Null until a server is bound to one organization.
   */
  boundBy: string | null;
  /** Whether setup has answered both of the questions that define a server. */
  isSetUp: boolean;
}

/**
 * The messages a server has one of. The living this week message is edited in
 * place and kept pinned, and the last digest is remembered so that pinning the
 * next one can unpin it.
 */
export type GuildMessagePurpose = 'thisweek' | 'digest';

export interface GuildMessage {
  guildId: string;
  purpose: GuildMessagePurpose;
  channelId: string;
  messageId: string;
}

/** Where a message the bot posted ended up. */
export interface PostedMessageRef {
  channelId: string;
  messageId: string;
}

/** What a binding is being set to, with the organization when it names one. */
export interface BindingChoice {
  binding: GuildBinding;
  rsoId?: number | null;
  /**
   * The Discord account the web platform confirmed may bind this server, which
   * is a board member of that organization or a global administrator. It is
   * written down only for a binding to one organization, because that is the
   * only binding the web platform is asked about.
   */
  boundBy?: string | null;
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
  /**
   * Every server that hears about an organization: the servers bound to it,
   * the servers that follow all of ECE, and the servers whose chosen set
   * contains it. A server that has not been set up is in none of them.
   */
  listGuildsFollowing(rsoId: number): Promise<GuildInstallation[]>;
  /** Every server that has been set up, for the jobs that run over all of them. */
  listInstallations(): Promise<GuildInstallation[]>;
  /** When the weekly digest is posted, on the campus clock. */
  setDigestSchedule(guildId: string, day: number, hour: number): Promise<void>;
  /** How far ahead the day of reminders are posted. */
  setReminderLeadMinutes(guildId: string, minutes: number): Promise<void>;
  /** Whether each digest is pinned and the one before it unpinned. */
  setDigestPinned(guildId: string, pinned: boolean): Promise<void>;
  /** Every server that has been set up and whose digest falls in this campus day and hour. */
  listInstallationsForDigest(dayOfWeek: number, hour: number): Promise<GuildInstallation[]>;
  /** Where a message of one purpose was posted, or null when there is none. */
  getGuildMessage(guildId: string, purpose: GuildMessagePurpose): Promise<GuildMessage | null>;
  /** Write down where a message of one purpose is now, replacing what was there. */
  setGuildMessage(guildId: string, purpose: GuildMessagePurpose, posted: PostedMessageRef): Promise<void>;
  /** Every message the bot holds for a server, which is what removal unpins. */
  listGuildMessages(guildId: string): Promise<GuildMessage[]>;
  removeGuildMessage(guildId: string, purpose: GuildMessagePurpose): Promise<void>;
  /** Map one VIA membership role to a Discord role in this server. */
  setRoleMapping(guildId: string, membershipRole: MappedRole, roleId: string): Promise<void>;
  /** Stop mapping one VIA membership role, which leaves every role already given alone. */
  unsetRoleMapping(guildId: string, membershipRole: MappedRole): Promise<void>;
  /** The Discord role each VIA membership role is mapped to here. */
  listRoleMappings(guildId: string): Promise<Partial<Record<MappedRole, string>>>;
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
    digestDay: row.digestDay,
    digestHour: row.digestHour,
    reminderLeadMinutes: row.reminderLeadMinutes,
    digestPinned: Boolean(row.digestPinned),
    boundBy: row.boundBy ?? null,
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
      const toOneRso = choice.binding === 'rso';
      await db.update(guildInstallations)
        .set({
          binding: choice.binding,
          rsoId: toOneRso ? (choice.rsoId ?? null) : null,
          // The board member is about the organization, so a server that is no
          // longer bound to one holds nobody to read its members as.
          boundBy: toOneRso ? (choice.boundBy ?? null) : null,
        })
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
     * The three ways a server can follow an organization are one question, so
     * they are one answer rather than three calls the caller has to put
     * together. The set is read first and folded into the same condition, so a
     * server appears once however many ways it qualifies.
     */
    async listGuildsFollowing(rsoId) {
      const inSet = await db.select().from(guildFollowedRsos)
        .where(eq(guildFollowedRsos.rsoId, rsoId));
      const setGuildIds = inSet.map(row => row.guildId);

      const conditions = [
        and(eq(guildInstallations.binding, 'rso'), eq(guildInstallations.rsoId, rsoId)),
        eq(guildInstallations.binding, 'all'),
      ];
      if (setGuildIds.length > 0) {
        conditions.push(and(
          eq(guildInstallations.binding, 'set'),
          inArray(guildInstallations.guildId, setGuildIds),
        ));
      }

      const rows = await db.select().from(guildInstallations)
        .where(and(isNotNull(guildInstallations.kind), or(...conditions)));
      return rows.map(present);
    },

    /**
     * Only the servers that have been set up. A server the bot was invited to
     * and never asked about has no kind and no binding, and a job that ran
     * over it would be posting into a server that has not asked for anything.
     */
    async listInstallations() {
      const rows = await db.select().from(guildInstallations)
        .where(and(isNotNull(guildInstallations.kind), isNotNull(guildInstallations.binding)));
      return rows.map(present);
    },

    async setDigestSchedule(guildId, day, hour) {
      await db.update(guildInstallations)
        .set({ digestDay: day, digestHour: hour })
        .where(eq(guildInstallations.guildId, guildId));
    },

    async setReminderLeadMinutes(guildId, minutes) {
      await db.update(guildInstallations)
        .set({ reminderLeadMinutes: minutes })
        .where(eq(guildInstallations.guildId, guildId));
    },

    async setDigestPinned(guildId, pinned) {
      await db.update(guildInstallations)
        .set({ digestPinned: pinned })
        .where(eq(guildInstallations.guildId, guildId));
    },

    /**
     * The servers whose digest hour this is. A server that has not been set up
     * is not one of them, whatever its columns say, because nothing is posted
     * in a server nobody has answered for.
     */
    async listInstallationsForDigest(dayOfWeek, hour) {
      const rows = await db.select().from(guildInstallations).where(and(
        isNotNull(guildInstallations.kind),
        isNotNull(guildInstallations.binding),
        eq(guildInstallations.digestDay, dayOfWeek),
        eq(guildInstallations.digestHour, hour),
      ));
      return rows.map(present);
    },

    async getGuildMessage(guildId, purpose) {
      const [row] = await db.select().from(guildMessages).where(and(
        eq(guildMessages.guildId, guildId),
        eq(guildMessages.purpose, purpose),
      ));
      return row ? { ...row, purpose: row.purpose as GuildMessagePurpose } : null;
    },

    async setGuildMessage(guildId, purpose, posted) {
      await db.insert(guildMessages)
        .values({ guildId, purpose, channelId: posted.channelId, messageId: posted.messageId })
        .onDuplicateKeyUpdate({ set: { channelId: posted.channelId, messageId: posted.messageId } });
    },

    async listGuildMessages(guildId) {
      const rows = await db.select().from(guildMessages)
        .where(eq(guildMessages.guildId, guildId));
      return rows.map(row => ({ ...row, purpose: row.purpose as GuildMessagePurpose }));
    },

    async removeGuildMessage(guildId, purpose) {
      await db.delete(guildMessages).where(and(
        eq(guildMessages.guildId, guildId),
        eq(guildMessages.purpose, purpose),
      ));
    },

    async setRoleMapping(guildId, membershipRole, roleId) {
      await db.insert(guildRoleMappings)
        .values({ guildId, membershipRole, roleId })
        .onDuplicateKeyUpdate({ set: { roleId } });
    },

    /**
     * Unmapping stops the bot touching that role from now on and leaves every
     * role it has already given alone, which is the same rule as never
     * removing a role it did not grant: what a server has handed out is the
     * server's.
     */
    async unsetRoleMapping(guildId, membershipRole) {
      await db.delete(guildRoleMappings).where(and(
        eq(guildRoleMappings.guildId, guildId),
        eq(guildRoleMappings.membershipRole, membershipRole),
      ));
    },

    async listRoleMappings(guildId) {
      const rows = await db.select().from(guildRoleMappings)
        .where(eq(guildRoleMappings.guildId, guildId));
      const mapped: Partial<Record<MappedRole, string>> = {};
      for (const row of rows) mapped[row.membershipRole as MappedRole] = row.roleId;
      return mapped;
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
      await db.delete(guildMessages).where(eq(guildMessages.guildId, guildId));
      await db.delete(guildRoleMappings).where(eq(guildRoleMappings.guildId, guildId));
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
