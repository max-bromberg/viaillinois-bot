import { featureById, type DiscordPermission } from '../features/registry.ts';
import { campusDatePlus, campusToday, toInstant } from '../render/campusTime.ts';
import { placeOf, trimDescription } from '../render/eventCard.ts';
import { NO_OUTBOX_ENTRY, guildTarget, type Deliveries } from '../delivery/deliveries.ts';
import { isMissingAccess, type DiscordActions, type ScheduledEventDraft } from '../discord/adapter.ts';
import type { EventMirrors } from './eventMirrors.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { RemovedGuildPresence } from '../commands/types.ts';
import type { EventQuery, ViaClient, ViaEvent } from '../via/client.ts';

/**
 * Native scheduled events.
 *
 * Every event coming up is mirrored into the server's own Events tab as a
 * Discord scheduled event of the external kind, so that a member can mark
 * themselves interested with Discord's own control and get Discord's own
 * reminders. Interest is what replaces the RSVPs the web platform removed,
 * and Discord's control is the one every member already knows.
 *
 * Only the occurrences inside a rolling window are mirrored, two weeks by
 * default and adjustable per server, because a term of weekly meetings would
 * otherwise fill the tab with sixteen entries nobody can read past. The window
 * rolls forward daily, creating what has entered it and leaving what has left
 * it alone: an event that has already happened is part of the server's own
 * history now, and deleting it would take a member's interest with it.
 *
 * Two rules keep the tab honest. An event an organization marked internal is
 * never mirrored, because a scheduled event is visible to everybody in the
 * server. An event that has been cancelled has its scheduled event deleted,
 * because a cancelled event that stays in the tab is worse than one that never
 * appeared.
 */

/** The feature a server switches on to have its Events tab kept in step. */
export const MIRROR_FEATURE = 'mirror.scheduled';

/** How many events one roll of the window reads at a time. */
export const ROLL_LIMIT = 200;

/** What a delivery of a scheduled event is for, which is one event in one server. */
export function mirrorPurpose(eventId: number): string {
  return `mirror:${eventId}`;
}

export interface ScheduledEventMirrorOptions {
  guilds: GuildStore;
  mirrors: EventMirrors;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'listEvents'>;
  disable: FeatureDisabler;
  now?: () => Date;
}

export interface ScheduledEventMirror {
  /**
   * Create or edit the scheduled event for one VIA event in one server. An
   * event inside the window that has no scheduled event yet gets one; an event
   * that already has one has it kept in step wherever it has moved to.
   */
  apply(installation: GuildInstallation, event: ViaEvent, outboxId: number): Promise<void>;
  /** Delete the scheduled event for one VIA event in one server, if there is one. */
  remove(installation: GuildInstallation, eventId: number): Promise<void>;
  /** Roll one server's window forward, creating what has entered it. */
  rollGuild(installation: GuildInstallation): Promise<number>;
  /** Whether an event falls inside this server's window. */
  isInsideWindow(installation: GuildInstallation, event: ViaEvent): boolean;
  /** Delete everything the bot put into a server, which is what removal does first. */
  removeGuildPresence(guildId: string): Promise<RemovedGuildPresence>;
}

/** What a Discord scheduled event says, drawn from the event itself. */
export function draftOf(event: ViaEvent): ScheduledEventDraft {
  const description = trimDescription(event.description);
  return {
    name: event.title,
    ...(description ? { description } : {}),
    startTime: event.startTime,
    endTime: event.endTime,
    location: placeOf(event),
  };
}

/** Which organizations a server hears about, or null when it hears about all of them. */
export function followedRsoIdsOf(
  installation: GuildInstallation,
  followedSet: readonly number[],
): number[] | null {
  if (installation.binding === 'rso') return installation.rsoId === null ? [] : [installation.rsoId];
  if (installation.binding === 'set') return [...followedSet];
  return null;
}

export function createScheduledEventMirror(options: ScheduledEventMirrorOptions): ScheduledEventMirror {
  const { guilds, mirrors, deliveries, actions, via, disable, now = () => new Date() } = options;
  const feature = featureById(MIRROR_FEATURE);

  function isInsideWindow(installation: GuildInstallation, event: ViaEvent): boolean {
    const start = toInstant(event.startTime);
    if (!start) return false;
    const at = now();
    if (start.getTime() < at.getTime()) return false;

    // The end of the window is the end of a campus day rather than an instant
    // a fortnight from this moment, because a window is counted in days.
    const lastDay = toInstant(`${campusDatePlus(installation.mirrorWindowDays, at)} 23:59:59`);
    return lastDay !== null && start.getTime() <= lastDay.getTime();
  }

  /**
   * Whether the bot may still create scheduled events here. A server that has
   * taken the permission away has broken the feature, so it is switched off
   * and the manager is told once rather than the bot failing every few
   * minutes for the rest of the term.
   */
  async function mayMirror(guildId: string): Promise<boolean> {
    const held: readonly DiscordPermission[] = await actions.permissionsIn(guildId);
    const granted = held.includes('Administrator')
      || feature.requiredPermissions.every(permission => held.includes(permission));
    if (granted) return true;

    await disable.disable(
      guildId,
      MIRROR_FEATURE,
      'the bot does not have the Manage Events permission here',
    );
    return false;
  }

  async function deleteScheduledEvent(guildId: string, eventId: number, scheduledEventId: string): Promise<boolean> {
    try {
      await actions.deleteScheduledEvent(guildId, scheduledEventId);
      return true;
    } catch (err) {
      // A scheduled event Discord no longer has is a scheduled event that is
      // gone, which is what was being asked for.
      if (!isMissingAccess(err) && (err as { code?: number }).code !== 10070) throw err;
      console.log(`the scheduled event ${scheduledEventId} in server ${guildId} was already gone`);
      return false;
    } finally {
      await mirrors.recordScheduledEvent(guildId, eventId, null);
    }
  }

  async function remove(installation: GuildInstallation, eventId: number): Promise<void> {
    const held = await mirrors.get(installation.guildId, eventId);
    if (!held?.scheduledEventId) return;
    await deleteScheduledEvent(installation.guildId, eventId, held.scheduledEventId);
  }

  async function apply(installation: GuildInstallation, event: ViaEvent, outboxId: number): Promise<void> {
    const guildId = installation.guildId;
    if (!(await guilds.isFeatureEnabled(guildId, MIRROR_FEATURE))) return;

    const held = await mirrors.get(guildId, event.eventId);

    // An event that has been cancelled, or that an organization has just
    // marked internal, leaves the tab rather than staying in it wrongly.
    if (event.cancelledAt !== null || event.isPrivate) {
      if (held?.scheduledEventId) {
        if (!(await mayMirror(guildId))) return;
        await deleteScheduledEvent(guildId, event.eventId, held.scheduledEventId);
      }
      return;
    }

    if (!held?.scheduledEventId && !isInsideWindow(installation, event)) return;
    if (!(await mayMirror(guildId))) return;

    if (held?.scheduledEventId) {
      await actions.editScheduledEvent(guildId, held.scheduledEventId, draftOf(event));
      return;
    }

    const intended = await deliveries.intend({
      outboxId,
      target: guildTarget(guildId),
      purpose: mirrorPurpose(event.eventId),
      kind: 'scheduled_event',
    });

    if (!intended.isNew) {
      // The scheduled event was created and the row that says so was not
      // written, which is the crash this delivery row exists to survive.
      if (intended.messageId) {
        await mirrors.recordScheduledEvent(guildId, event.eventId, intended.messageId);
      }
      return;
    }

    const scheduledEventId = await actions.createScheduledEvent(guildId, draftOf(event));
    await deliveries.recordPosted(intended.deliveryId, scheduledEventId);
    await mirrors.recordScheduledEvent(guildId, event.eventId, scheduledEventId);
  }

  return {
    apply,
    remove,
    isInsideWindow,

    /**
     * One server's window, rolled forward. Everything the server follows that
     * begins inside the window is applied, which creates what has entered it
     * and keeps what is already there in step. Nothing is deleted: an
     * occurrence that has left the window has happened, and it belongs to the
     * server's own history now.
     */
    async rollGuild(installation: GuildInstallation): Promise<number> {
      const guildId = installation.guildId;
      if (!installation.isSetUp) return 0;
      if (!(await guilds.isFeatureEnabled(guildId, MIRROR_FEATURE))) return 0;

      const rsoIds = followedRsoIdsOf(installation, await guilds.listFollowedRsos(guildId));
      if (rsoIds !== null && rsoIds.length === 0) return 0;

      const at = now();
      const query: EventQuery = {
        ...(rsoIds === null ? {} : { rsoIds }),
        from: campusToday(at),
        to: campusDatePlus(installation.mirrorWindowDays, at),
        limit: ROLL_LIMIT,
      };

      const page = await via.listEvents(query);
      let mirrored = 0;
      for (const event of page.events) {
        await apply(installation, event, NO_OUTBOX_ENTRY);
        mirrored += 1;
      }
      return mirrored;
    },

    /**
     * What removal clears before the rows that say where it is are deleted.
     * Every scheduled event the bot created in the server goes, and the rows
     * go with them.
     *
     * Nothing is unpinned yet, because nothing is pinned yet: the message the
     * bot pins is the living this week message, which arrives in the third
     * increment, and its unpinning belongs here when it does.
     */
    async removeGuildPresence(guildId: string): Promise<RemovedGuildPresence> {
      const held = await mirrors.listByGuild(guildId);
      let scheduledEvents = 0;

      for (const row of held) {
        if (!row.scheduledEventId) continue;
        try {
          if (await deleteScheduledEvent(guildId, row.eventId, row.scheduledEventId)) {
            scheduledEvents += 1;
          }
        } catch (err) {
          console.error(
            `deleting the scheduled event ${row.scheduledEventId} in server ${guildId} failed:`,
            (err as Error).message,
          );
        }
      }

      await mirrors.removeGuild(guildId);
      return { scheduledEvents, unpinnedMessages: 0 };
    },
  };
}
