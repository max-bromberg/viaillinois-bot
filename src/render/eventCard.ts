import { campusDate, campusDateTime, campusTimeOfDay, relativeTimestamp } from './campusTime.ts';
import type { Reply, ReplyButton, ReplyRow } from '../discord/adapter.ts';
import type { RsoWithEvents, ViaEvent } from '../via/client.ts';

/**
 * The event card and the organization card.
 *
 * The card is the one place a student reads everything about one event, and
 * everything on it is written the way the website writes it: the campus clock
 * with Discord's relative timestamp beside it, the room with the board's note
 * underneath, and the description as the board wrote it. Two things change
 * what an event means and are therefore marked rather than left to be
 * noticed: an event marked internal, and an event that has been cancelled.
 *
 * Nothing here reaches the web platform or Discord. A card is a function from
 * an event to a reply, which is why every claim about what a card says is a
 * test that builds an event and reads a string.
 */

/** How much of a description a card carries before it sends the reader to the website. */
export const MAX_DESCRIPTION_LENGTH = 400;

/** How many events an organization card lists. */
export const RSO_EVENT_COUNT = 5;

export interface CardOptions {
  /** The public address of the website, which the link buttons open. */
  websiteUrl: string;
  /**
   * Whether the person reading this card has a VIA account, which is what
   * decides whether the administrative buttons are on it. The caller says so
   * rather than the card asking, because a card answered privately is read by
   * one person the caller has already resolved, and a card posted into a
   * channel is read by everybody.
   */
  linked?: boolean;
  /**
   * Whether to offer the button that opens this card privately. An
   * announcement is read by a whole channel and Discord cannot show one person
   * a button and another person nothing, so a message everybody reads carries
   * one button that opens the card for whoever pressed it, and the card that
   * opens carries the administrative buttons.
   */
  manageable?: boolean;
  /**
   * The identifier of the listing this card was opened from, when it was
   * opened from one. A card opened from a listing replaces the listing,
   * because it is the same message edited in place, so the way back to it has
   * to be on the card.
   */
  backTo?: string | null;
}

/** The identifiers the card's own buttons carry, which the commands answer. */
export const EVENT_BUTTON = {
  remind: (eventId: number) => `event:remind:${eventId}`,
  interested: (eventId: number) => `event:interested:${eventId}`,
  calendar: (eventId: number) => `event:calendar:${eventId}`,
};

export const RSO_BUTTON = {
  follow: (rsoId: number) => `rso:follow:${rsoId}`,
};

/**
 * The administrative buttons, which are the six actions of section 6.7 of the
 * design. They are written here rather than in the module that answers them
 * because the card is what carries them, and they are shown only where the
 * caller says the reader has a VIA account. Whether that person may actually
 * act is the web platform's answer when one of them is pressed, never this
 * card's.
 */
export const CARD_ADMIN_BUTTON = {
  manage: (eventId: number) => `admin:manage:${eventId}`,
  // The three that open a form carry a prefix of their own, because Discord
  // takes a form only as the first thing said about an interaction and the
  // dispatcher has to know which of these buttons might answer with one.
  postpone: (eventId: number) => `admin:form:postpone:${eventId}`,
  describe: (eventId: number) => `admin:form:describe:${eventId}`,
  note: (eventId: number) => `admin:form:note:${eventId}`,
  cancel: (eventId: number) => `admin:cancel:${eventId}`,
  visibility: (eventId: number) => `admin:visibility:${eventId}`,
  repost: (eventId: number) => `admin:repost:${eventId}`,
};

/** The page for one event on the website. */
export function eventAddress(eventId: number, websiteUrl: string): string {
  return `${websiteUrl.replace(/\/+$/, '')}/events/${eventId}`;
}

/** The page for one organization on the website. */
export function rsoAddress(rsoId: number, websiteUrl: string): string {
  return `${websiteUrl.replace(/\/+$/, '')}/rsos/${rsoId}`;
}

/**
 * Anything that happens somewhere, which is an event and also an exam. Both
 * carry a room VIA knows, a place written by hand, or neither, so both are
 * written by the same two functions rather than by two that nearly agree.
 */
export interface Placed {
  building: string | null;
  roomNumber: string | null;
  locationText: string | null;
}

/** Anything that runs from one time to another. */
export interface Timed {
  startTime: string;
  endTime: string;
}

/**
 * Where the event is. A room VIA knows is shown as its building and room, a
 * place written by hand is shown as it was written, and an event with neither
 * says so, because an empty line reads as a bot that lost the answer.
 */
export function placeOf(place: Placed): string {
  const room = [place.building, place.roomNumber].filter(Boolean).join(' ');
  if (room) return room;
  if (place.locationText) return place.locationText;
  return 'The place has not been announced yet.';
}

/**
 * When the event runs. The date is written once when the event begins and
 * ends on the same campus day, and twice when it runs past midnight, so a
 * reader is never told an event ends before it starts.
 */
export function whenOf(occasion: Timed): string {
  const start = campusDateTime(occasion.startTime);
  if (!start) return '';
  const end = campusDate(occasion.endTime) === campusDate(occasion.startTime)
    ? campusTimeOfDay(occasion.endTime)
    : campusDateTime(occasion.endTime);
  const relative = relativeTimestamp(occasion.startTime);
  const range = end ? `${start} to ${end}` : start;
  return relative ? `${range} (${relative})` : range;
}

const DAY_NAMES: Record<string, string> = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday',
  TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
};

/** A list in the words a person writes it in, so three days read as a sentence. */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What a series repeats on, in the three fields that say it. */
export interface SeriesPattern {
  intervalWeeks: number | null;
  daysOfWeek: string | null;
  endsOn: string | null;
}

/**
 * The pattern a series repeats on, written out. A recurring meeting is one
 * thing rather than sixteen, and a card that says so saves a student working
 * it out from a list of identical titles.
 *
 * The sentence is built here rather than in the card, because the
 * announcement of a series has the pattern from the series itself rather than
 * from one of its meetings and has to say the same thing.
 */
export function describePattern(pattern: SeriesPattern): string {
  const weeks = pattern.intervalWeeks ?? 1;
  const every = weeks <= 1 ? 'every week' : `every ${weeks} weeks`;
  const days = (pattern.daysOfWeek ?? '')
    .split(',')
    .map(code => DAY_NAMES[code.trim().toUpperCase()])
    .filter(Boolean) as string[];

  const parts = [`This meeting repeats ${every}`];
  if (days.length > 0) parts.push(` on ${joinWords(days)}`);
  if (pattern.endsOn) parts.push(`, until ${campusDate(pattern.endsOn)}`);
  return `${parts.join('')}.`;
}

/** The pattern of the series an event belongs to, or nothing for an event that stands alone. */
export function patternOf(event: ViaEvent): string {
  if (!event.seriesId) return '';
  return describePattern({
    intervalWeeks: event.seriesIntervalWeeks,
    daysOfWeek: event.seriesDaysOfWeek,
    endsOn: event.seriesEndsOn,
  });
}

/** The description, cut at a word rather than in the middle of one. */
export function trimDescription(description: string | null): string {
  const text = (description ?? '').trim();
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

function linkButton(label: string, url: string): ReplyButton {
  return { kind: 'button', style: 'link', label, url };
}

/** One event, in full, with the four buttons the design names. */
export function renderEventCard(event: ViaEvent, options: CardOptions): Reply {
  const cancelled = event.cancelledAt !== null;
  const lines: string[] = [];

  const markers: string[] = [];
  if (cancelled) markers.push('cancelled');
  if (event.isPrivate) markers.push('internal');
  lines.push(markers.length > 0 ? `**${event.title}** (${markers.join(', ')})` : `**${event.title}**`);

  if (event.rsoName) lines.push(event.rsoName);
  lines.push('');

  if (cancelled) {
    lines.push('This event has been cancelled, so it is not going ahead at the time below.');
  }
  lines.push(`When: ${whenOf(event)}`);
  lines.push(`Where: ${placeOf(event)}`);
  if (event.locationNote) lines.push(event.locationNote);

  const pattern = patternOf(event);
  if (pattern) lines.push(pattern);

  const description = trimDescription(event.description);
  if (description) {
    lines.push('');
    lines.push(description);
    if (description.endsWith('...')) lines.push('Read the rest on viaillinois.com.');
  }

  const everybody: ReplyButton[] = [
    {
      kind: 'button',
      style: 'primary',
      label: 'Remind me',
      customId: EVENT_BUTTON.remind(event.eventId),
      // There is nothing to be reminded of once an event is cancelled.
      disabled: cancelled,
    },
    {
      kind: 'button',
      style: 'secondary',
      label: 'Interested',
      customId: EVENT_BUTTON.interested(event.eventId),
      disabled: cancelled,
    },
    {
      kind: 'button',
      style: 'secondary',
      label: 'Add to calendar',
      customId: EVENT_BUTTON.calendar(event.eventId),
    },
    linkButton('Open on VIA', eventAddress(event.eventId, options.websiteUrl)),
  ];

  const rows: ReplyRow[] = [{ kind: 'row', components: everybody }];

  /**
   * The two buttons that are about the card rather than about the event: the
   * one that opens it again with the board actions on it, and the one that
   * goes back to the listing it was opened from. They sit in a row of their
   * own because Discord takes five buttons in a row and the four above are
   * what everybody gets.
   */
  const aboutTheCard: ReplyButton[] = [];
  if (options.manageable) {
    aboutTheCard.push({
      kind: 'button',
      style: 'secondary',
      label: 'Manage this event',
      customId: CARD_ADMIN_BUTTON.manage(event.eventId),
    });
  }
  if (options.backTo) {
    aboutTheCard.push({
      kind: 'button',
      style: 'secondary',
      label: 'Back to the list',
      customId: options.backTo,
    });
  }
  if (aboutTheCard.length > 0) rows.push({ kind: 'row', components: aboutTheCard });

  // Discord takes five buttons in a row, and there are six administrative
  // actions, so they sit in two rows in the order a board does them.
  if (options.linked) {
    rows.push({
      kind: 'row',
      components: [
        { kind: 'button', style: 'primary', label: 'Move', customId: CARD_ADMIN_BUTTON.postpone(event.eventId) },
        { kind: 'button', style: 'danger', label: 'Cancel', customId: CARD_ADMIN_BUTTON.cancel(event.eventId) },
        { kind: 'button', style: 'secondary', label: 'Description', customId: CARD_ADMIN_BUTTON.describe(event.eventId) },
        {
          kind: 'button',
          style: 'secondary',
          label: event.isPrivate ? 'Make public' : 'Make internal',
          customId: CARD_ADMIN_BUTTON.visibility(event.eventId),
        },
        { kind: 'button', style: 'secondary', label: 'Note', customId: CARD_ADMIN_BUTTON.note(event.eventId) },
      ],
    });
    rows.push({
      kind: 'row',
      components: [
        { kind: 'button', style: 'secondary', label: 'Announce again', customId: CARD_ADMIN_BUTTON.repost(event.eventId) },
      ],
    });
  }

  return { content: lines.join('\n'), components: rows };
}

/** One organization, its description, and the events it has coming up. */
export function renderRsoCard(answer: RsoWithEvents, options: CardOptions): Reply {
  const { rso, events } = answer;
  const lines: string[] = [`**${rso.name}**`];

  const description = trimDescription(rso.description);
  if (description) {
    lines.push('');
    lines.push(description);
  }

  lines.push('');
  if (events.length === 0) {
    lines.push(`${rso.name} has nothing coming up right now.`);
  } else {
    lines.push('Coming up:');
    for (const event of events.slice(0, RSO_EVENT_COUNT)) {
      lines.push(`- ${eventSummary(event)}`);
    }
  }

  return {
    content: lines.join('\n'),
    components: [{
      kind: 'row',
      components: [
        { kind: 'button', style: 'primary', label: 'Follow', customId: RSO_BUTTON.follow(rso.rsoId) },
        linkButton('Open on VIA', rsoAddress(rso.rsoId, options.websiteUrl)),
      ],
    }],
  };
}

/**
 * One event on one line: the title, when it is on the campus clock with the
 * relative timestamp beside it, and the markers that change what it means.
 * Both the organization card and the listing are built from this, so a row
 * reads the same wherever it appears.
 */
export function eventSummary(event: ViaEvent, options: { withRso?: boolean } = {}): string {
  const markers: string[] = [];
  if (event.cancelledAt !== null) markers.push('cancelled');
  if (event.isPrivate) markers.push('internal');

  const parts = [`**${event.title}**`];
  if (options.withRso && event.rsoName) parts.push(event.rsoName);
  parts.push(`${campusDateTime(event.startTime)} ${relativeTimestamp(event.startTime)}`.trim());
  const room = [event.building, event.roomNumber].filter(Boolean).join(' ');
  if (room) parts.push(room);
  else if (event.locationText) parts.push(event.locationText);

  const line = parts.join(', ');
  return markers.length > 0 ? `${line} (${markers.join(', ')})` : line;
}
