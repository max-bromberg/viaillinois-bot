import { campusDate, campusTimeOfDay, campusToday, relativeTimestamp, toInstant } from './campusTime.ts';
import { eventAddress, placeOf, type CardOptions } from './eventCard.ts';
import type { Reply } from '../discord/adapter.ts';
import type { ViaEvent } from '../via/client.ts';

/**
 * The week, written four ways.
 *
 * The personal digest, the digest a server posts, the reminders and the living
 * this week message are the same list of events written for a different
 * reader, so they are one module over one grouping. A week is grouped by day
 * because thirty events in one column is not a week anybody can read, and each
 * line carries the hour, the title, the organization and the room, which is
 * what somebody deciding whether to go needs.
 *
 * The rule from sections 9 and 10 of the design lives here too: every direct
 * message the bot sends ends with the way to stop that kind of message. A post
 * in a channel carries no such sentence, because what stops it is the server
 * manager switching the feature off, and a channel of forty people does not
 * need forty opt outs.
 */

/** How a person stops the weekly digest. */
export const DIGEST_STOP_SENTENCE =
  'You receive this because you follow organizations on VIA. Run the feed settings command to change the day and the hour it arrives, or to stop these messages.';

/** How a person stops the reminders. */
export const REMINDER_STOP_SENTENCE =
  'You receive this because you asked to be reminded of this event. Press Remind me again on the event to take it back, or run the feed settings command to stop the direct messages VIA sends you.';

/** What a week with nothing in it says, so that silence is never the answer. */
export const NOTHING_COMING_UP = 'There is nothing coming up in this week.';

/** One campus day of a week, with the events that fall on it. */
export interface DayGroup {
  /** The campus date, as YYYY-MM-DD. */
  day: string;
  /** The day as a person reads it, such as Mon, Sep 7. */
  label: string;
  events: ViaEvent[];
}

/** What a digest is drawn from: a week and the events that fall in it. */
export interface WeekListing {
  /** The Sunday the week begins on, as YYYY-MM-DD. */
  weekStart: string;
  events: readonly ViaEvent[];
}

/**
 * The events of a week, grouped by the campus day they fall on and ordered
 * within the day. The day is the campus day rather than the UTC day, because
 * an event at nine in the evening on campus is already tomorrow in UTC and
 * belongs in Monday's list rather than Tuesday's.
 */
export function groupByCampusDay(events: readonly ViaEvent[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();

  for (const event of events) {
    const instant = toInstant(event.startTime);
    // An event VIA sent without a start is an event nothing can be said about.
    if (!instant) continue;
    const day = campusToday(instant);
    if (!groups.has(day)) groups.set(day, { day, label: campusDate(instant), events: [] });
    groups.get(day)!.events.push(event);
  }

  return [...groups.values()]
    .sort((left, right) => left.day.localeCompare(right.day))
    .map(group => ({
      ...group,
      events: [...group.events].sort((left, right) =>
        (toInstant(left.startTime)?.getTime() ?? 0) - (toInstant(right.startTime)?.getTime() ?? 0)),
    }));
}

/** One event on one line of a digest, under the day it falls on. */
export function digestLine(event: ViaEvent): string {
  const parts = [
    campusTimeOfDay(event.startTime),
    `**${event.title}**`,
  ];
  if (event.rsoName) parts.push(event.rsoName);
  parts.push(placeOf(event));
  const line = parts.filter(Boolean).join(', ');
  return event.cancelledAt !== null ? `${line} (cancelled)` : line;
}

/** The week itself, grouped by day, or the sentence that says it is empty. */
function weekBody(events: readonly ViaEvent[]): string[] {
  const groups = groupByCampusDay(events);
  if (groups.length === 0) return [NOTHING_COMING_UP];

  const lines: string[] = [];
  for (const group of groups) {
    lines.push('', `**${group.label}**`);
    for (const event of group.events) lines.push(`- ${digestLine(event)}`);
  }
  // The first line is the blank one before the first day.
  return lines.slice(1);
}

/** How a week reads at the head of a digest. */
function weekHeading(weekStart: string): string {
  const start = toInstant(weekStart);
  const end = start ? new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000) : null;
  return end
    ? `${campusDate(start)} to ${campusDate(end)}`
    : weekStart;
}

/** The weekly direct message somebody who follows organizations receives. */
export function renderPersonalDigest(listing: WeekListing): string {
  return [
    `**Your week on VIA**, ${weekHeading(listing.weekStart)}`,
    '',
    ...weekBody(listing.events),
    '',
    DIGEST_STOP_SENTENCE,
  ].join('\n');
}

/** The direct message somebody receives before an event they asked about. */
export function renderPersonalReminder(event: ViaEvent, leadMinutes: number): string {
  return [
    `**${event.title}** starts in about ${leadMinutes} minutes.`,
    '',
    `When: ${campusTimeOfDay(event.startTime)} ${relativeTimestamp(event.startTime)}`.trim(),
    `Where: ${placeOf(event)}`,
    ...(event.locationNote ? [event.locationNote] : []),
    '',
    REMINDER_STOP_SENTENCE,
  ].join('\n');
}

/** The weekly digest a server posts in the channel bound to it. */
export function renderGuildDigest(listing: WeekListing): Reply {
  return {
    content: [
      `**The week ahead on VIA**, ${weekHeading(listing.weekStart)}`,
      '',
      ...weekBody(listing.events),
    ].join('\n'),
    components: [],
  };
}

/** The short reminder a server posts before an event of the day. */
export function renderDayOfReminder(event: ViaEvent, options: CardOptions): Reply {
  const lines = [
    `**${event.title}** is today.`,
    '',
    `When: ${campusTimeOfDay(event.startTime)} ${relativeTimestamp(event.startTime)}`.trim(),
    `Where: ${placeOf(event)}`,
  ];
  if (event.locationNote) lines.push(event.locationNote);

  return {
    content: lines.join('\n'),
    components: [{
      kind: 'row',
      components: [{
        kind: 'button',
        style: 'link',
        label: 'Open on VIA',
        url: eventAddress(event.eventId, options.websiteUrl),
      }],
    }],
  };
}

export interface ThisWeekListing extends WeekListing {
  /** When the message was last brought up to date. */
  updatedAt: Date;
}

/**
 * The one message a server keeps pinned. It is edited in place rather than
 * posted again, so it says when it was last brought up to date: without that,
 * a week with nothing in it reads the same as a bot that has stopped.
 */
export function renderThisWeek(listing: ThisWeekListing): Reply {
  return {
    content: [
      `**This week on VIA**, ${weekHeading(listing.weekStart)}`,
      '',
      ...weekBody(listing.events),
      '',
      `Last brought up to date at ${campusTimeOfDay(listing.updatedAt)} on ${campusDate(listing.updatedAt)}.`,
    ].join('\n'),
    components: [],
  };
}
