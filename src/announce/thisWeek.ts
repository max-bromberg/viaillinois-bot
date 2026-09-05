import { NO_OUTBOX_ENTRY, channelTarget, type Deliveries } from '../delivery/deliveries.ts';
import { channelFor, noChannelReason } from '../guilds/channels.ts';
import { followedEvents } from './followedEvents.ts';
import { campusDatePlus, campusToday } from '../render/campusTime.ts';
import { campusWeekStart } from '../jobs/clock.ts';
import { renderThisWeek } from '../render/digest.ts';
import { isMissingAccess, isMissingMessage, type DiscordActions } from '../discord/adapter.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * The living this week message.
 *
 * One message the bot posts once, pins, and then edits in place whenever the
 * week changes, so that a channel always has a current list at the top rather
 * than a column of listings that were current on the day they were posted.
 * This is the kiosk's rotating list as a Discord surface.
 *
 * It is brought up to date twice over: once an hour by a job, so that an event
 * which has happened leaves the list, and by the outbox handlers whenever an
 * event of a followed organization changes, so that a meeting moved at nine in
 * the morning is right in the channel at one minute past.
 *
 * Where the message is lives in Guild_Messages, because Discord has no way to
 * ask which message the bot posted last week. A message somebody deleted is
 * replaced rather than mourned, and a channel the bot can no longer post in
 * switches the feature off and tells the manager once, as every other
 * proactive feature does.
 */

/** The feature a server switches on to have a this week message kept current. */
export const THISWEEK_FEATURE = 'living.thisweek';

/**
 * What the delivery of the message is for. It carries no week, because there
 * is one message rather than one a week: the week it shows changes as the
 * message is edited.
 */
export const THISWEEK_PURPOSE = 'thisweek';

export interface ThisWeekOptions {
  guilds: GuildStore;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'listEvents'>;
  disable: FeatureDisabler;
}

/** What one pass over the servers did, which is what the log reads. */
export interface ThisWeekResult {
  /** How many servers had the message posted for the first time. */
  posted: number;
  /** How many servers had their message brought up to date. */
  updated: number;
  /** How many servers failed, each of them logged. */
  failed: number;
}

export interface ThisWeekMessage {
  /** Bring one server's message up to date, posting it if there is none yet. */
  refresh(installation: GuildInstallation, at: Date): Promise<boolean>;
  /** Bring every server's message up to date, which is the hourly job. */
  refreshAll(at: Date): Promise<ThisWeekResult>;
  /** Bring up to date every server that follows one organization. */
  refreshFollowing(rsoId: number, at: Date): Promise<ThisWeekResult>;
}

export function createThisWeekMessage(options: ThisWeekOptions): ThisWeekMessage {
  const { guilds, deliveries, actions, via, disable } = options;

  /**
   * The week as it stands now: everything still to come between today and the
   * Saturday this campus week ends on. The heading names the whole week, and
   * the list carries what is left of it, because a list at the top of a
   * channel is read for what to turn up to rather than for what was missed.
   */
  async function weekOf(installation: GuildInstallation, at: Date) {
    const weekStart = campusWeekStart(at);
    const events = await followedEvents({ guilds, via }, installation, {
      from: campusToday(at),
      to: campusDatePlus(6, new Date(`${weekStart}T12:00:00Z`)),
    });
    return renderThisWeek({ weekStart, events, updatedAt: at });
  }

  /** Post the message for the first time, pin it, and write down where it is. */
  async function post(
    installation: GuildInstallation,
    channelId: string,
    at: Date,
  ): Promise<boolean> {
    const guildId = installation.guildId;
    const intended = await deliveries.intend({
      outboxId: NO_OUTBOX_ENTRY,
      target: channelTarget(channelId),
      purpose: THISWEEK_PURPOSE,
      kind: 'message',
    });

    if (!intended.isNew) {
      // The message was posted and the row that says where was not written,
      // which is the crash this delivery row exists to survive.
      if (intended.messageId) {
        await guilds.setGuildMessage(guildId, 'thisweek', {
          channelId,
          messageId: intended.messageId,
        });
      }
      return false;
    }

    let messageId: string;
    try {
      messageId = await actions.postMessage(channelId, await weekOf(installation, at));
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      await disable.disable(guildId, THISWEEK_FEATURE, noChannelReason('thisweek'));
      return false;
    }

    await deliveries.recordPosted(intended.deliveryId, messageId);
    await guilds.setGuildMessage(guildId, 'thisweek', { channelId, messageId });

    try {
      await actions.pinMessage(channelId, messageId);
    } catch (err) {
      // A message that could not be pinned is still the current week, and a
      // feature switched off over a pin would be a worse answer than one
      // sitting a little further up the channel.
      if (!isMissingAccess(err)) throw err;
      console.log(`the this week message in server ${guildId} could not be pinned`);
    }
    return true;
  }

  async function refresh(installation: GuildInstallation, at: Date): Promise<boolean> {
    const guildId = installation.guildId;
    const channelId = await channelFor({ guilds, disable }, guildId, THISWEEK_FEATURE, 'thisweek');
    if (!channelId) return false;

    const held = await guilds.getGuildMessage(guildId, 'thisweek');
    // A manager who bound a different channel is asking for the message to be
    // there instead, so the old one is left where it is and a new one posted.
    if (!held || held.channelId !== channelId) return post(installation, channelId, at);

    try {
      await actions.editMessage(held.channelId, held.messageId, await weekOf(installation, at));
      return true;
    } catch (err) {
      if (isMissingMessage(err)) {
        // Somebody deleted the pinned message, so the server has no current
        // week any more and one is posted again.
        console.log(`the this week message in server ${guildId} is no longer there`);
        await guilds.removeGuildMessage(guildId, 'thisweek');
        return postAgain(installation, channelId, at);
      }
      if (!isMissingAccess(err)) throw err;
      await disable.disable(guildId, THISWEEK_FEATURE, noChannelReason('thisweek'));
      return false;
    }
  }

  /**
   * Post a replacement for a message somebody deleted. The delivery row for
   * the first message is already recorded, so this one is posted outside that
   * key: what makes it happen once is that it only happens when Discord has
   * said the message is gone.
   */
  async function postAgain(
    installation: GuildInstallation,
    channelId: string,
    at: Date,
  ): Promise<boolean> {
    const guildId = installation.guildId;
    let messageId: string;
    try {
      messageId = await actions.postMessage(channelId, await weekOf(installation, at));
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      await disable.disable(guildId, THISWEEK_FEATURE, noChannelReason('thisweek'));
      return false;
    }

    await guilds.setGuildMessage(guildId, 'thisweek', { channelId, messageId });
    try {
      await actions.pinMessage(channelId, messageId);
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      console.log(`the this week message in server ${guildId} could not be pinned`);
    }
    return true;
  }

  /** Bring a list of servers up to date, one failure never stopping the rest. */
  async function refreshEach(
    installations: readonly GuildInstallation[],
    at: Date,
  ): Promise<ThisWeekResult> {
    const result: ThisWeekResult = { posted: 0, updated: 0, failed: 0 };

    for (const installation of installations) {
      try {
        const had = await guilds.getGuildMessage(installation.guildId, 'thisweek');
        if (await refresh(installation, at)) {
          if (had) result.updated += 1;
          else result.posted += 1;
        }
      } catch (err) {
        result.failed += 1;
        console.error(
          `bringing the this week message in server ${installation.guildId} up to date failed:`,
          (err as Error).message,
        );
      }
    }
    return result;
  }

  return {
    refresh,

    async refreshAll(at: Date): Promise<ThisWeekResult> {
      return refreshEach(await guilds.listInstallations(), at);
    },

    async refreshFollowing(rsoId: number, at: Date): Promise<ThisWeekResult> {
      return refreshEach(await guilds.listGuildsFollowing(rsoId), at);
    },
  };
}
