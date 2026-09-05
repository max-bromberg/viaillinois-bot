import { campusDate, campusTimeOfDay, campusToday, relativeTimestamp, toInstant } from './campusTime.ts';
import { eventAddress, placeOf, type CardOptions } from './eventCard.ts';
import { MAX_MESSAGE_LENGTH } from '../discord/adapter.ts';
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

/**
 * How long a reminder can be asked for ahead of an event, in the words of the
 * menu that offers it.
 *
 * It lives here rather than beside the command that offers the menu because
 * three places read it: the menu itself, the settings panel, and the reminder
 * the bot sends, and the last of those is a rendering rather than a command.
 */
export const LEAD_CHOICES: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: 'An hour before' },
  { minutes: 120, label: 'Two hours before' },
  { minutes: 240, label: 'Four hours before' },
  { minutes: 1440, label: 'A day before' },
];

/**
 * How long a lead time is, in the words a sentence carries it in.
 *
 * A person chose one of the menu's own answers, so they read that answer back
 * rather than the number of minutes the bot happens to store it as: somebody
 * who chose "A day before" is told "a day", not "1440 minutes". A lead time
 * that is not one of the menu's, which is one a server set before the menu
 * had it, is written in hours where it divides into them.
 */
export function describeLead(minutes: number): string {
  const choice = LEAD_CHOICES.find(one => one.minutes === minutes);
  if (choice) {
    const words = choice.label.replace(/ before$/, '');
    return words.charAt(0).toLowerCase() + words.slice(1);
  }
  if (minutes > 0 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? 'an hour' : `${hours} hours`;
  }
  return `${minutes} minutes`;
}

/** How a person stops the weekly digest. */
export const DIGEST_STOP_SENTENCE =
  'You receive this because you follow organizations on VIA. Run the feed settings command to change the day and the hour it arrives, or to stop these messages.';

/**
 * How a person stops hearing that an event they asked about was cancelled.
 * It does not offer the Remind me button, because the event it would be
 * pressed on is not happening.
 */
export const CANCELLED_STOP_SENTENCE =
  'You receive this because you asked to be reminded of this event, and that reminder has now been removed. Run the feed settings command to stop the direct messages VIA sends you.';

/** How a person stops the reminders. */
export const REMINDER_STOP_SENTENCE =
  'You receive this because you asked to be reminded of this event. Press Remind me again on the event to take it back, or run the feed settings command to stop the direct messages VIA sends you.';

/** What a week with nothing in it says, so that silence is never the answer. */
export const NOTHING_COMING_UP = 'There is nothing coming up this week.';

// How long a message Discord will carry is Discord's own limit, named beside
// the rest of what the library knows, and reached from here under the name the
// renderings were first written against.
export { MAX_MESSAGE_LENGTH } from '../discord/adapter.ts';

/** Where the days a message could not carry are, said in one sentence. */
export const REST_OF_THE_WEEK = 'The rest of the week is on viaillinois.com.';

/**
 * A message, as the three parts every listing here is made of: what comes
 * before the list, the list as one group of lines per day, and what comes
 * after it.
 *
 * It is written as three parts rather than as one array of lines because that
 * is what says which lines may be dropped. The head and the tail are always
 * kept, because the tail is how a person stops the message and a message
 * without it is one the design does not allow. The days are what a busy week
 * has too many of.
 */
export interface MessageLines {
  head: readonly string[];
  days: readonly (readonly string[])[];
  tail?: readonly string[];
}

/** Every line of a message, with a blank line between one day and the next. */
function assemble(lines: MessageLines, days: readonly (readonly string[])[], cut: boolean): string {
  const body: string[] = [];
  for (const [index, day] of days.entries()) {
    if (index > 0) body.push('');
    body.push(...day);
  }
  return [
    ...lines.head,
    ...body,
    ...(lines.tail ?? []),
    ...(cut ? ['', REST_OF_THE_WEEK] : []),
  ].join('\n');
}

/**
 * Fit a message into what Discord will carry.
 *
 * Discord refuses a message longer than two thousand characters outright, so a
 * busy week with nothing done about it is a digest nobody receives at all,
 * which is a worse answer than a short one. The list is cut a whole day at a
 * time, because half a Tuesday reads as a fault rather than as a message that
 * ran out of room, and the message says where the rest of the week is.
 *
 * A single day with more in it than one message will hold is cut a line at a
 * time, and a message with no days in it at all is cut where it stands. Both
 * are last resorts, and both are better than a message Discord will not take.
 */
export function fitToMessage(lines: MessageLines, limit: number = MAX_MESSAGE_LENGTH): string {
  const whole = assemble(lines, lines.days, false);
  if (whole.length <= limit) return whole;

  // Whole days first, from the end of the week, because the days a reader
  // needs soonest are the ones at the top.
  for (let kept = lines.days.length - 1; kept >= 1; kept -= 1) {
    const fitted = assemble(lines, lines.days.slice(0, kept), true);
    if (fitted.length <= limit) return fitted;
  }

  // One day, cut a line at a time, keeping the heading it belongs to.
  const first = lines.days[0] ?? [];
  for (let rows = first.length - 1; rows >= 1; rows -= 1) {
    const fitted = assemble(lines, [first.slice(0, rows)], true);
    if (fitted.length <= limit) return fitted;
  }

  // Nothing that can be dropped a line at a time is left, which is a head or
  // a tail longer than a message on its own.
  const bare = assemble(lines, [], true);
  return bare.length <= limit ? bare : `${bare.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * One campus day of a week, with the things that fall on it. The week the
 * exams message is grouped into is the same shape as the week a digest is
 * grouped into, so both go through one function over anything with a start.
 */
export interface DayGroup<T = ViaEvent> {
  /** The campus date, as YYYY-MM-DD. */
  day: string;
  /** The day as a person reads it, such as Mon, Sep 7. */
  label: string;
  events: T[];
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
export function groupByCampusDay<T extends { startTime: string }>(events: readonly T[]): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();

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

/**
 * The week itself, one group of lines per day, or the one sentence that says
 * it is empty. They are groups rather than one list because a week that will
 * not fit in a message is cut a whole day at a time.
 */
export function weekDays(events: readonly ViaEvent[]): string[][] {
  const groups = groupByCampusDay(events);
  if (groups.length === 0) return [[NOTHING_COMING_UP]];

  return groups.map(group => [
    `**${group.label}**`,
    ...group.events.map(event => `- ${digestLine(event)}`),
  ]);
}

/** How a week reads at the head of a digest, and at the head of the exams message. */
export function weekHeading(weekStart: string): string {
  const start = toInstant(weekStart);
  const end = start ? new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000) : null;
  return end
    ? `${campusDate(start)} to ${campusDate(end)}`
    : weekStart;
}

/** The weekly direct message somebody who follows organizations receives. */
export function renderPersonalDigest(listing: WeekListing): string {
  return fitToMessage({
    head: [`**Your week on VIA**, ${weekHeading(listing.weekStart)}`, ''],
    days: weekDays(listing.events),
    tail: ['', DIGEST_STOP_SENTENCE],
  });
}

/** The direct message somebody receives before an event they asked about. */
export function renderPersonalReminder(event: ViaEvent, leadMinutes: number): string {
  return [
    `**${event.title}** starts in about ${describeLead(leadMinutes)}.`,
    '',
    `When: ${campusTimeOfDay(event.startTime)} ${relativeTimestamp(event.startTime)}`.trim(),
    `Where: ${placeOf(event)}`,
    ...(event.locationNote ? [event.locationNote] : []),
    '',
    REMINDER_STOP_SENTENCE,
  ].join('\n');
}

/**
 * The direct message somebody receives when an event they asked to be
 * reminded of is cancelled. A reminder for something that is not happening is
 * worse than no reminder at all, so the message says that the event is off and
 * that the reminder has gone with it.
 */
export function renderCancelledReminder(event: ViaEvent): string {
  const organization = event.rsoName ? ` from ${event.rsoName}` : '';
  return [
    `**${event.title}**${organization} has been cancelled, so it is not going ahead.`,
    '',
    `It was to run on ${campusDate(event.startTime)} at ${campusTimeOfDay(event.startTime)}.`,
    '',
    CANCELLED_STOP_SENTENCE,
  ].join('\n');
}

/** The weekly digest a server posts in the channel bound to it. */
export function renderGuildDigest(listing: WeekListing): Reply {
  return {
    content: fitToMessage({
      head: [`**The week ahead on VIA**, ${weekHeading(listing.weekStart)}`, ''],
      days: weekDays(listing.events),
    }),
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
    content: fitToMessage({
      head: [`**This week on VIA**, ${weekHeading(listing.weekStart)}`, ''],
      days: weekDays(listing.events),
      tail: [
        '',
        `Last brought up to date at ${campusTimeOfDay(listing.updatedAt)} on ${campusDate(listing.updatedAt)}.`,
      ],
    }),
    components: [],
  };
}
