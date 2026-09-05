import { NO_OUTBOX_ENTRY, channelTarget, type Deliveries } from '../delivery/deliveries.ts';
import { channelFor, noChannelReason } from '../guilds/channels.ts';
import { followedEvents } from '../announce/followedEvents.ts';
import { campusDatePlus } from '../render/campusTime.ts';
import { renderGuildDigest } from '../render/digest.ts';
import { isMissingAccess, isMissingMessage, type DiscordActions } from '../discord/adapter.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { JobHour } from './scheduler.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * The weekly digest a server posts.
 *
 * On the day and at the hour the server chose, one message listing the coming
 * week for the organizations it follows, grouped by day. It is one message
 * rather than one per event because a channel that receives thirty separate
 * posts on a Sunday evening is a channel people mute.
 *
 * A server can ask for the digest to be pinned, in which case the one before
 * it is unpinned, so the channel always has the current week at the top and
 * never a column of old ones. What was pinned is remembered in Guild_Messages,
 * because Discord has no way to ask which message the bot pinned last week.
 */

/** The feature a server switches on to receive the weekly digest. */
export const DIGEST_FEATURE = 'announce.digest';

/** How far ahead the digest looks, which is the coming week. */
export const DIGEST_DAYS = 6;

/** What a delivery of a digest is for, which is one server and one week. */
export function guildDigestPurpose(day: string): string {
  return `digest:${day}`;
}

export interface GuildDigestJobOptions {
  guilds: GuildStore;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'listEvents'>;
  disable: FeatureDisabler;
}

/** What one run did, which is what the log reads. */
export interface GuildDigestResult {
  posted: number;
  /** How many servers were passed over, because the digest was already posted. */
  skipped: number;
  /** How many servers failed, each of them logged. */
  failed: number;
}

export interface GuildDigestJob {
  run(hour: JobHour): Promise<GuildDigestResult>;
}

export function createGuildDigestJob(options: GuildDigestJobOptions): GuildDigestJob {
  const { guilds, deliveries, actions, via, disable } = options;

  /**
   * Pin the digest just posted and unpin the one before it. A pin that fails
   * is logged and nothing more: the digest itself has been posted, and a
   * channel with an unpinned digest in it is a smaller fault than a feature
   * switched off over a pin.
   */
  async function pin(
    installation: GuildInstallation,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const previous = await guilds.getGuildMessage(installation.guildId, 'digest');
    if (previous) {
      try {
        await actions.unpinMessage(previous.channelId, previous.messageId);
      } catch (err) {
        if (!isMissingMessage(err) && !isMissingAccess(err)) throw err;
        console.log(`the digest pinned in server ${installation.guildId} is no longer there`);
      }
    }

    try {
      await actions.pinMessage(channelId, messageId);
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      console.log(`the digest in server ${installation.guildId} could not be pinned`);
    }
    await guilds.setGuildMessage(installation.guildId, 'digest', { channelId, messageId });
  }

  return {
    async run(hour: JobHour): Promise<GuildDigestResult> {
      const result: GuildDigestResult = { posted: 0, skipped: 0, failed: 0 };
      const due = await guilds.listInstallationsForDigest(hour.dayOfWeek, hour.hour);

      for (const installation of due) {
        const guildId = installation.guildId;
        try {
          const channelId = await channelFor({ guilds, disable }, guildId, DIGEST_FEATURE, 'digest');
          if (!channelId) continue;

          const intended = await deliveries.intend({
            outboxId: NO_OUTBOX_ENTRY,
            target: channelTarget(channelId),
            purpose: guildDigestPurpose(hour.day),
            kind: 'message',
          });
          if (!intended.isNew) {
            result.skipped += 1;
            continue;
          }

          const events = await followedEvents({ guilds, via }, installation, {
            from: hour.day,
            to: campusDatePlus(DIGEST_DAYS, hour.at),
          });

          let messageId: string;
          try {
            messageId = await actions.postMessage(
              channelId,
              renderGuildDigest({ weekStart: hour.day, events }),
            );
          } catch (err) {
            if (!isMissingAccess(err)) throw err;
            // The channel the server bound has been deleted or closed to the
            // bot, which is the same fault as unbinding it.
            await disable.disable(guildId, DIGEST_FEATURE, noChannelReason('digest'));
            continue;
          }

          await deliveries.recordPosted(intended.deliveryId, messageId);
          if (installation.digestPinned) await pin(installation, channelId, messageId);
          result.posted += 1;
        } catch (err) {
          result.failed += 1;
          console.error(`posting the weekly digest in server ${guildId} failed:`, (err as Error).message);
        }
      }

      if (result.posted > 0) {
        console.log(`the weekly digest was posted in ${result.posted} servers`);
      }
      return result;
    },
  };
}
