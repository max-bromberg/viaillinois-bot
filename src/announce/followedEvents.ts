import { followedRsoIdsOf } from '../mirror/scheduledEvents.ts';
import type { GuildInstallation, GuildStore } from '../guilds/store.ts';
import type { ViaClient, ViaEvent } from '../via/client.ts';

/**
 * The events a server hears about, between two campus days.
 *
 * Which organizations a server hears about is one question with three answers,
 * and the scheduled event mirror already asks it: a server bound to one
 * organization hears about that one, a server bound to a set hears about the
 * set, and a server bound to all of ECE hears about everything. This adds the
 * one thing every timed post needs on top of that, which is the reading call
 * itself, so that the digest, the day of reminders and the living this week
 * message all ask for the same events in the same way.
 *
 * Internal events are never asked for. A channel is read by everybody in the
 * server, and an event an organization marked internal is for the members of
 * that organization.
 */

/** How many events one timed post reads at a time. */
export const LISTING_LIMIT = 200;

/**
 * How many events a message that lists a week asks for.
 *
 * Discord carries two thousand characters, and a line of a digest runs to
 * something under a hundred, so a message holds somewhere around twenty five
 * days and events together. Sixty is comfortably more than any message will
 * show and small enough that a busy term does not read two hundred rows out
 * of the web platform every hour to throw most of them away. What is read and
 * does not fit is cut by fitToMessage, which says where the rest of the week
 * is.
 */
export const WEEK_LISTING_LIMIT = 60;

export interface FollowedEventsOptions {
  guilds: GuildStore;
  via: Pick<ViaClient, 'listEvents'>;
}

export interface DayRange {
  /** The first campus day, as YYYY-MM-DD. */
  from: string;
  /** The last campus day, as YYYY-MM-DD. */
  to: string;
  limit?: number;
}

export async function followedEvents(
  options: FollowedEventsOptions,
  installation: GuildInstallation,
  range: DayRange,
): Promise<ViaEvent[]> {
  if (!installation.isSetUp) return [];

  const rsoIds = followedRsoIdsOf(
    installation,
    await options.guilds.listFollowedRsos(installation.guildId),
  );
  // A server bound to a set that nobody put anything in hears about nothing,
  // which is not the same as a server that hears about everything.
  if (rsoIds !== null && rsoIds.length === 0) return [];

  const page = await options.via.listEvents({
    ...(rsoIds === null ? {} : { rsoIds }),
    from: range.from,
    to: range.to,
    limit: range.limit ?? LISTING_LIMIT,
  });
  return page.events;
}
