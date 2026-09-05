import {
  outboxChangedFields, outboxEvent, outboxSeries,
  type OutboxEntry, type SeriesChange, type ViaClient, type ViaEvent,
} from '../via/client.ts';
import {
  isMove, renderCancellationNotice, renderEventAnnouncement, renderMoveNotice,
  renderRemovedAnnouncement, renderSeriesAnnouncement,
} from '../render/announcement.ts';
import { channelTarget, type Deliveries } from '../delivery/deliveries.ts';
import { isMissingAccess, isMissingMessage, type DiscordActions, type Reply } from '../discord/adapter.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';
import type { EventMirror, EventMirrors } from '../mirror/eventMirrors.ts';
import type { ScheduledEventMirror } from '../mirror/scheduledEvents.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';

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
 * Every post goes through Deliveries first, keyed by the outbox entry, the
 * channel and the kind, so that an entry handled twice posts once.
 */

/** The feature a server switches on to hear about new events. */
export const NEW_FEATURE = 'announce.new';

/** The feature a server switches on to hear about changes to what it was told. */
export const CHANGES_FEATURE = 'announce.changes';

/** What a delivery of a change notice is for, beside the edit of the announcement. */
export function noticePurpose(kind: string): string {
  return `${kind}:notice`;
}

export const NO_CHANNEL_REASON = 'no channel is bound to announcements';

/**
 * Which feature an entry belongs to. A server chooses to hear about new
 * events and to hear about changes to what it was told separately, because
 * they are two different amounts of noise in a channel.
 */
export function featureFor(kind: string): string {
  return kind.endsWith('.created') ? NEW_FEATURE : CHANGES_FEATURE;
}

export interface AnnouncementHandlerOptions {
  guilds: GuildStore;
  mirrors: EventMirrors;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'getEvent'>;
  disable: FeatureDisabler;
  /** The public address of the website, which the buttons on a card open. */
  websiteUrl: string;
  /** The Events tab, kept in step by the same handlers. Left out where a run has none. */
  mirror?: ScheduledEventMirror;
}

export function createAnnouncementHandlers(options: AnnouncementHandlerOptions): OutboxHandlers {
  const { guilds, mirrors, deliveries, actions, via, disable, websiteUrl, mirror } = options;
  const cardOptions = { websiteUrl };

  /**
   * The channel a server announces in, or nothing when it has none. A server
   * with the feature on and no channel bound has broken it, so the feature is
   * switched off and the manager is told once.
   */
  async function announcementChannel(guildId: string, featureId: string): Promise<string | null> {
    if (!(await guilds.isFeatureEnabled(guildId, featureId))) return null;
    const channels = await guilds.listChannels(guildId);
    if (channels.announcements) return channels.announcements;

    await disable.disable(guildId, featureId, NO_CHANNEL_REASON);
    return null;
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

    if (!intended.isNew) {
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
      // which is the same fault as unbinding it.
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
    if (!intended.isNew) return;

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
    if (!intended.isNew) return;

    let messageId: string;
    try {
      messageId = await actions.postMessage(channelId, { content }, {
        replyToMessageId: held.announcementMessageId!,
      });
    } catch (err) {
      if (!isMissingAccess(err)) throw err;
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
    for (const installation of await serversFor(entry, event)) {
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
    for (const installation of await serversFor(entry, event)) {
      const held = await announcementFor(installation.guildId, eventIds);
      // A server that never announced this event has nothing to keep current.
      if (!held) continue;
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
    },

    async 'event.updated'(entry) {
      const event = eventOf(entry);
      if (!event) return;
      const changed = outboxChangedFields(entry);

      await announceChange(
        entry,
        [event.eventId],
        renderEventAnnouncement(event, cardOptions),
        isMove(changed) ? renderMoveNotice(event, changed) : null,
        event,
      );
      await mirrorEvent(entry, event);
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
    },

    async 'series.deleted'(entry) {
      const change = outboxSeries(entry);
      if (!change) return;

      const eventIds = [...new Set([...change.eventIds, ...change.affectedEventIds])];
      await announceChange(entry, eventIds, renderRemovedAnnouncement(null), null, null);
      await unmirrorEvents(entry, eventIds, null);
    },
  };
}
