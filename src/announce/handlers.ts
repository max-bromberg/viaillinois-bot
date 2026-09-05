import {
  outboxChangedFields, outboxEvent, outboxReason, outboxSeries,
  type OutboxEntry, type SeriesChange, type ViaClient, type ViaEvent,
} from '../via/client.ts';
import {
  isMove, renderCancellationNotice, renderEventAnnouncement, renderInternalAnnouncement,
  renderMoveNotice, renderRemovedAnnouncement, renderSeriesAnnouncement,
} from '../render/announcement.ts';
import { renderCancelledReminder } from '../render/digest.ts';
import { channelTarget, userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { createSpread, type SpreadOptions } from '../delivery/spread.ts';
import { channelFor, noChannelReason } from '../guilds/channels.ts';
import { isMissingAccess, isMissingMessage, type DiscordActions, type Reply } from '../discord/adapter.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';
import type { EventMirror, EventMirrors } from '../mirror/eventMirrors.ts';
import type { ScheduledEventMirror } from '../mirror/scheduledEvents.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { ThisWeekMessage } from './thisWeek.ts';

/**
 * What the bot posts when the outbox says something happened.
 *
 * One handler per outbox kind, and each of them does the same two things for
 * every server that follows the organization the entry belongs to: it keeps
 * the server's announcement current, and it keeps the server's Events tab in
 * step. They are done together because they are one event arriving in one
 * server, and a server that saw an announcement of a meeting that has moved
 * should not still have the old time in its Events tab.
 *
 * The rules from section 6.3 of the design are here.
 *
 * A series is announced once, listing the pattern and the end date, and never
 * once per occurrence. The one announcement is written down against the first
 * meeting of the series, so a later change to the series finds it again from
 * the meetings the entry names.
 *
 * A change edits the announcement in place, so that an announcement always
 * describes the event as it is now. A move or a cancellation also posts a
 * short notice that replies to the announcement, because an edit alone tells
 * nobody who has already read it.
 *
 * A deletion edits the announcement to say the event was removed. An
 * announcement of something that is not happening is worse than no
 * announcement at all.
 *
 * An event an organization marked internal is never announced, because an
 * announcements channel is read by the whole server and an internal event is
 * for the members of one organization.
 *
 * A cancellation reaches one more set of people. Somebody who pressed Remind
 * me asked to be told about that event, and an event that is not happening is
 * the thing they most need to be told, so each of them receives one direct
 * message and their reminder goes with it. That is what the cancellation
 * command promises whoever cancelled, and this is where it is kept.
 *
 * Every post goes through Deliveries first, keyed by the outbox entry, the
 * channel or the person, and the kind, so that an entry handled twice posts
 * once.
 */

/** The feature a server switches on to hear about new events. */
export const NEW_FEATURE = 'announce.new';

/** The feature a server switches on to hear about changes to what it was told. */
export const CHANGES_FEATURE = 'announce.changes';

/** What a delivery of a change notice is for, beside the edit of the announcement. */
export function noticePurpose(kind: string): string {
  return `${kind}:notice`;
}

export const NO_CHANNEL_REASON = noChannelReason('announcements');

/**
 * Which feature an entry belongs to. A server chooses to hear about new
 * events and to hear about changes to what it was told separately, because
 * they are two different amounts of noise in a channel.
 */
export function featureFor(kind: string): string {
  return kind.endsWith('.created') ? NEW_FEATURE : CHANGES_FEATURE;
}

export interface AnnouncementHandlerOptions extends SpreadOptions {
  guilds: GuildStore;
  mirrors: EventMirrors;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'getEvent' | 'getLink'>;
  /**
   * The reminders people asked for, which a cancellation reads and then
   * clears, and the preferences that say whether the bot may write to them.
   */
  feed: Pick<FeedStore, 'remindersForEvent' | 'preferences' | 'savePreferences' | 'removeReminder'>;
  /** How one direct message is sent, which is the same seam the jobs use. */
  deliver: DirectMessageDelivery;
  disable: FeatureDisabler;
  /** The public address of the website, which the buttons on a card open. */
  websiteUrl: string;
  /** The Events tab, kept in step by the same handlers. Left out where a run has none. */
  mirror?: ScheduledEventMirror;
  /**
   * The living this week message, brought up to date by the same handlers, so
   * that a meeting moved at nine in the morning is right in the channel at one
   * minute past rather than at ten. Left out where a run has none.
   */
  thisWeek?: ThisWeekMessage;
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export function createAnnouncementHandlers(options: AnnouncementHandlerOptions): OutboxHandlers {
  const {
    guilds, mirrors, deliveries, actions, via, feed, deliver, disable, websiteUrl, mirror,
    thisWeek, now = () => new Date(),
  } = options;
  const cardOptions = { websiteUrl };
  /**
   * The pause between one server and the next. One event created on the
   * website reaches every server that follows the organization, and section 9
   * of the design asks that those posts are spread rather than fired in the
   * same second.
   */
  const spread = createSpread(options);

  /**
   * The channel a server announces in, or nothing when it has none. A server
   * with the feature on and no channel bound has broken it, so the feature is
   * switched off and the manager is told once, which channelFor does.
   */
  async function announcementChannel(guildId: string, featureId: string): Promise<string | null> {
    return channelFor({ guilds, disable }, guildId, featureId, 'announcements');
  }

  /** Every server that hears about this entry's organization. */
  async function serversFor(entry: OutboxEntry, event: ViaEvent | null): Promise<GuildInstallation[]> {
    const rsoId = entry.rsoId ?? event?.rsoId ?? null;
    if (rsoId === null) return [];
    return guilds.listGuildsFollowing(rsoId);
  }

  /**
   * Post one announcement, once. The delivery row is written before the post
   * and carries the message it left behind, so an entry handled again after a
   * crash finds the message rather than posting a second one.
   */
  async function post(
    entry: OutboxEntry,
    guildId: string,
    channelId: string,
    eventId: number,
    reply: Reply,
  ): Promise<void> {
    const intended = await deliveries.intend({
      outboxId: entry.outboxId,
      target: channelTarget(channelId),
      purpose: entry.kind,
      kind: 'message',
    });

    // A row that carries the moment it was posted is a post that has been
    // made, and a row that carries none is one that was intended and never
    // made, which is still owed and is made now.
    if (!intended.isNew && intended.deliveredAt !== null) {
      if (intended.messageId) {
        await mirrors.recordAnnouncement(guildId, eventId, { channelId, messageId: intended.messageId });
      }
      return;
    }

    let messageId: string;
    try {
      messageId = await actions.postMessage(channelId, reply);
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      // The channel the server bound has been deleted or closed to the bot,
      // which is the same fault as unbinding it. The intention goes with the
      // feature, because there is nowhere left for it to be posted.
      await deliveries.abandon(intended.deliveryId);
      await disable.disable(guildId, featureFor(entry.kind), NO_CHANNEL_REASON);
      return;
    }

    await deliveries.recordPosted(intended.deliveryId, messageId);
    await mirrors.recordAnnouncement(guildId, eventId, { channelId, messageId });
  }

  /** Edit an announcement in place, if it is still there to edit. */
  async function edit(entry: OutboxEntry, held: EventMirror, reply: Reply): Promise<void> {
    const channelId = held.announcementChannelId!;
    const intended = await deliveries.intend({
      outboxId: entry.outboxId,
      target: channelTarget(channelId),
      purpose: entry.kind,
      kind: 'edit',
    });
    if (!intended.isNew && intended.deliveredAt !== null) return;

    try {
      await actions.editMessage(channelId, held.announcementMessageId!, reply);
    } catch (err) {
      // Somebody deleted the announcement. There is nothing to keep current,
      // and nothing anybody needs to do about it.
      if (!isMissingMessage(err) && !isMissingAccess(err)) throw err;
      console.log(`the announcement of event ${held.eventId} in server ${held.guildId} is no longer there`);
    }
    await deliveries.recordPosted(intended.deliveryId, held.announcementMessageId);
  }

  /** Post the short notice that replies to an announcement, once. */
  async function notice(entry: OutboxEntry, held: EventMirror, content: string): Promise<void> {
    const channelId = held.announcementChannelId!;
    const intended = await deliveries.intend({
      outboxId: entry.outboxId,
      target: channelTarget(channelId),
      purpose: noticePurpose(entry.kind),
      kind: 'message',
    });
    if (!intended.isNew && intended.deliveredAt !== null) return;

    let messageId: string;
    try {
      messageId = await actions.postMessage(channelId, { content }, {
        replyToMessageId: held.announcementMessageId!,
      });
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
      // There is no channel left to reply in, so the notice is owed to
      // nobody and the row that said it was owed goes with it.
      await deliveries.abandon(intended.deliveryId);
      return;
    }
    await deliveries.recordPosted(intended.deliveryId, messageId);
  }

  /** The announcement a server already made for any of these events. */
  async function announcementFor(guildId: string, eventIds: readonly number[]): Promise<EventMirror | null> {
    const held = await mirrors.findAnnouncement(guildId, eventIds);
    return held?.announcementChannelId && held.announcementMessageId ? held : null;
  }

  /** Announce something new, in every server that follows it. */
  async function announceNew(entry: OutboxEntry, event: ViaEvent, reply: Reply): Promise<void> {
    for (const [index, installation] of (await serversFor(entry, event)).entries()) {
      await spread(index);
      const channelId = await announcementChannel(installation.guildId, NEW_FEATURE);
      if (channelId) await post(entry, installation.guildId, channelId, event.eventId, reply);
    }
  }

  /**
   * Keep an announcement current in every server that made one, and add the
   * notice when the change is one a reader has to be told about rather than
   * shown.
   */
  async function announceChange(
    entry: OutboxEntry,
    eventIds: readonly number[],
    reply: Reply,
    noticeContent: string | null,
    event: ViaEvent | null,
  ): Promise<void> {
    // Counted over the servers that actually have an announcement to keep
    // current, so that a server with nothing to do costs nothing and the
    // first server that does is not waited for.
    let posted = 0;
    for (const installation of await serversFor(entry, event)) {
      const held = await announcementFor(installation.guildId, eventIds);
      // A server that never announced this event has nothing to keep current.
      if (!held) continue;
      await spread(posted);
      posted += 1;
      if (!(await guilds.isFeatureEnabled(installation.guildId, CHANGES_FEATURE))) continue;

      await edit(entry, held, reply);
      if (noticeContent) await notice(entry, held, noticeContent);
    }
  }

  /** Keep the Events tab of every following server in step with one event. */
  async function mirrorEvent(entry: OutboxEntry, event: ViaEvent): Promise<void> {
    if (!mirror) return;
    for (const installation of await serversFor(entry, event)) {
      await mirror.apply(installation, event, entry.outboxId);
    }
  }

  /** Take one event out of the Events tab of every following server. */
  async function unmirrorEvents(entry: OutboxEntry, eventIds: readonly number[], event: ViaEvent | null): Promise<void> {
    if (!mirror) return;
    for (const installation of await serversFor(entry, event)) {
      for (const eventId of eventIds) await mirror.remove(installation, eventId);
    }
  }

  /**
   * Bring the living this week message up to date in every server that hears
   * about this organization. A failure here is logged and nothing more: the
   * announcement has been posted, and the hourly job will put the message
   * right on its next pass.
   */
  async function refreshThisWeek(entry: OutboxEntry, event: ViaEvent | null): Promise<void> {
    if (!thisWeek) return;
    const at = now();
    for (const installation of await serversFor(entry, event)) {
      try {
        await thisWeek.refresh(installation, at);
      } catch (err) {
        console.error(
          `bringing the this week message in server ${installation.guildId} up to date failed:`,
          (err as Error).message,
        );
      }
    }
  }

  /** Roll the window of every following server, which is what a series change asks for. */
  async function mirrorSeries(entry: OutboxEntry): Promise<void> {
    if (!mirror) return;
    for (const installation of await serversFor(entry, null)) {
      await mirror.rollGuild(installation);
    }
  }

  /** The first meeting of a series, which is what its announcement is drawn from. */
  async function firstMeeting(change: SeriesChange): Promise<ViaEvent | null> {
    const ordered = [...change.eventIds].sort((left, right) => left - right);
    for (const eventId of ordered) {
      const event = await via.getEvent(eventId);
      if (event) return event;
    }
    return null;
  }

  /**
   * Tell everybody holding a reminder for this event that it is not happening,
   * and then take the reminder away.
   *
   * Three things decide whether the message is sent, and each of them is one
   * the bot obeys everywhere else: the person's own direct message switch,
   * whether the web platform still knows the account, and Deliveries, keyed by
   * the entry and the person. The reminder goes whichever way those answer,
   * because the event is cancelled and a reminder for it would fire about
   * nothing.
   */
  async function tellReminderHolders(entry: OutboxEntry, event: ViaEvent): Promise<void> {
    for (const reminder of await feed.remindersForEvent(event.eventId)) {
      const discordUserId = reminder.discordUserId;
      const preferences = await feed.preferences(discordUserId);
      const writable = !preferences.directMessageOptOut && Boolean(await via.getLink(discordUserId));

      if (writable) {
        const intended = await deliveries.intend({
          outboxId: entry.outboxId,
          target: userTarget(discordUserId),
          purpose: entry.kind,
          kind: 'direct_message',
        });

        if (intended.isNew || intended.deliveredAt === null) {
          const outcome = await deliver(discordUserId, { content: renderCancelledReminder(event) });
          if (outcome === 'failed') {
            // The delivery row stays pending and the reminder stays where it
            // is, which together say the message is still owed, and the entry
            // is asked for again.
            throw new Error(`telling ${discordUserId} that event ${event.eventId} was cancelled failed`);
          }
          if (outcome === 'blocked') {
            await feed.savePreferences(discordUserId, { directMessageOptOut: true });
          }
          // A blocked message is recorded as well, because it is not going to
          // arrive on a second attempt either.
          await deliveries.recordPosted(intended.deliveryId, null);
        }
      }

      await feed.removeReminder(reminder.reminderId);
    }
  }

  /** The event an entry carries, or nothing when the entry is not about one. */
  function eventOf(entry: OutboxEntry): ViaEvent | null {
    const event = outboxEvent(entry);
    if (!event) console.log(`outbox entry ${entry.outboxId} of kind ${entry.kind} carries no event`);
    return event;
  }

  return {
    async 'event.created'(entry) {
      const event = eventOf(entry);
      if (!event) return;
      // An internal event is announced nowhere and mirrored nowhere, and the
      // mirror refuses it for itself as well.
      if (!event.isPrivate) {
        await announceNew(entry, event, renderEventAnnouncement(event, cardOptions));
      }
      await mirrorEvent(entry, event);
      await refreshThisWeek(entry, event);
    },

    async 'series.created'(entry) {
      const change = outboxSeries(entry);
      if (!change) return;

      const first = await firstMeeting(change);
      // A series whose meetings VIA no longer has is a series that was
      // created and undone between the entry and this poll.
      if (!first) {
        console.log(`the series ${entry.subjectId} has no meeting to announce`);
        return;
      }

      if (!first.isPrivate) {
        await announceNew(entry, first, renderSeriesAnnouncement(first, change.series, cardOptions));
      }
      await mirrorSeries(entry);
      await refreshThisWeek(entry, first);
    },

    async 'event.updated'(entry) {
      const event = eventOf(entry);
      if (!event) return;
      const changed = outboxChangedFields(entry);

      // An event the organization has marked internal keeps none of its
      // details in a channel the whole server reads, and there is nothing to
      // post a notice about either: the change is that it is no longer
      // announced here.
      await announceChange(
        entry,
        [event.eventId],
        event.isPrivate
          ? renderInternalAnnouncement()
          : renderEventAnnouncement(event, cardOptions),
        !event.isPrivate && isMove(changed)
          ? renderMoveNotice(event, changed, outboxReason(entry))
          : null,
        event,
      );
      await mirrorEvent(entry, event);
      await refreshThisWeek(entry, event);
    },

    async 'event.cancelled'(entry) {
      const event = eventOf(entry);
      if (!event) return;

      await announceChange(
        entry,
        [event.eventId],
        renderEventAnnouncement(event, cardOptions),
        renderCancellationNotice(event),
        event,
      );
      await mirrorEvent(entry, event);
      await tellReminderHolders(entry, event);
      await refreshThisWeek(entry, event);
    },

    async 'event.deleted'(entry) {
      const event = eventOf(entry);
      if (!event) return;

      await announceChange(
        entry,
        [event.eventId],
        renderRemovedAnnouncement(event.title),
        null,
        event,
      );
      await unmirrorEvents(entry, [event.eventId], event);
      await refreshThisWeek(entry, event);
    },

    async 'series.updated'(entry) {
      const change = outboxSeries(entry);
      if (!change) return;

      const first = await firstMeeting(change);
      const eventIds = [...new Set([...change.eventIds, ...change.affectedEventIds])];
      if (first) {
        await announceChange(
          entry,
          eventIds,
          renderSeriesAnnouncement(first, change.series, cardOptions),
          null,
          first,
        );
      }
      await mirrorSeries(entry);
      await refreshThisWeek(entry, first);
    },

    async 'series.deleted'(entry) {
      const change = outboxSeries(entry);
      if (!change) return;

      const eventIds = [...new Set([...change.eventIds, ...change.affectedEventIds])];
      await announceChange(entry, eventIds, renderRemovedAnnouncement(null), null, null);
      await unmirrorEvents(entry, eventIds, null);
      await refreshThisWeek(entry, null);
    },
  };
}
