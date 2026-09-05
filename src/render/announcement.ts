import { campusDateTime, relativeTimestamp } from './campusTime.ts';
import { describePattern, placeOf, renderEventCard, type CardOptions } from './eventCard.ts';
import type { Reply } from '../discord/adapter.ts';
import type { ViaEvent, ViaSeries } from '../via/client.ts';

/**
 * What the bot posts into a server's announcements channel.
 *
 * An announcement is the event card with one line above it saying why it has
 * appeared, so that a channel reading it can tell a new event from a change
 * without reading the whole card. The card underneath is the same card the
 * event command answers with, buttons and all, because an announcement a
 * student cannot act on is a notice board rather than a bot.
 *
 * Three rules from section 6.3 of the design live here. A series is announced
 * once, with the pattern it repeats on and the date it ends, rather than once
 * per meeting. A change edits the announcement in place, so the announcement
 * always describes the event as it is now, and a move or a cancellation adds a
 * short notice that replies to it, because an edit alone tells nobody who has
 * already read it. An event that was removed leaves an announcement that says
 * so, because an announcement of something that is not happening is worse than
 * no announcement at all.
 */

/** The fields whose change means the event has moved in time or in place. */
export const MOVE_FIELDS = [
  'start_time', 'end_time', 'location_id', 'building', 'room_number', 'location_text',
];

const TIME_FIELDS = ['start_time', 'end_time'];

/** Whether what changed is a move, which is what a notice is posted for. */
export function isMove(changed: readonly string[]): boolean {
  return changed.some(field => MOVE_FIELDS.includes(field));
}

function headlineFor(event: ViaEvent, what: string): string {
  return event.rsoName ? `${event.rsoName} has ${what}` : `There is ${what}`;
}

/**
 * The card with a line above it saying that this event is new.
 *
 * Every announcement carries the button that opens the card privately, because
 * a message a whole channel reads cannot show one person the administrative
 * actions and another person nothing. Whoever presses it gets the card with
 * the actions on it, and whether they may use any of them is the web
 * platform's answer when they do.
 */
export function renderEventAnnouncement(event: ViaEvent, options: CardOptions): Reply {
  const card = renderEventCard(event, { ...options, manageable: true });
  const headline = event.rsoName
    ? `**${event.rsoName}** has a new event on VIA.`
    : 'There is a new event on VIA.';
  return { ...card, content: `${headline}\n\n${card.content}` };
}

/**
 * One announcement for a whole series. The card is drawn from the first
 * meeting, because that is what a reader wants to know first, and the pattern
 * comes from the series itself, so it is right even when the meeting the card
 * was drawn from does not carry it.
 */
export function renderSeriesAnnouncement(
  event: ViaEvent,
  series: ViaSeries,
  options: CardOptions,
): Reply {
  const card = renderEventCard(event, { ...options, manageable: true });
  const headline = event.rsoName
    ? `**${event.rsoName}** has a new set of meetings on VIA.`
    : 'There is a new set of meetings on VIA.';

  const pattern = describePattern({
    intervalWeeks: series.intervalWeeks,
    daysOfWeek: series.daysOfWeek,
    endsOn: series.endsOn,
  });
  // The card carries the pattern already when the meeting it was drawn from
  // knows which series it belongs to, and saying it twice reads as a fault.
  const content = card.content.includes(pattern)
    ? card.content
    : `${card.content}\n${pattern}`;

  return { ...card, content: `${headline}\n\n${content}\n\nThe first meeting is the one above.` };
}

/**
 * The notice that replies to an announcement when the event has moved. It
 * names what changed and what it changed to, so that somebody who read the
 * announcement yesterday does not have to compare two messages, and it carries
 * the reason when whoever moved it gave one.
 */
export function renderMoveNotice(
  event: ViaEvent,
  changed: readonly string[],
  reason: string | null = null,
): string {
  const timeChanged = changed.some(field => TIME_FIELDS.includes(field));
  const placeChanged = changed.some(field => MOVE_FIELDS.includes(field) && !TIME_FIELDS.includes(field));

  const what = timeChanged && placeChanged
    ? 'has moved to a new time and a new place'
    : timeChanged
      ? 'has moved to a new time'
      : 'has changed room';

  const when = `${campusDateTime(event.startTime)} ${relativeTimestamp(event.startTime)}`.trim();
  return [
    `**${event.title}** ${what}.`,
    `It now runs on ${when}, in ${placeOf(event)}.`,
    // A board that said why is saying it to the channel, so the notice carries
    // it rather than leaving people to guess.
    ...(reason ? [`The reason given: ${reason}`] : []),
    'The announcement above has been updated to match.',
  ].join('\n');
}

/** The notice that replies to an announcement when the event has been cancelled. */
export function renderCancellationNotice(event: ViaEvent): string {
  return [
    `**${event.title}** has been cancelled, so it is not going ahead.`,
    'The announcement above has been marked as cancelled.',
  ].join('\n');
}

/**
 * What an announcement becomes when the thing it announced was removed from
 * VIA. The buttons go with it, because there is nothing left to be reminded
 * of or interested in.
 */
export function renderRemovedAnnouncement(title: string | null): Reply {
  const subject = title ? `**${title}**` : 'What was announced here';
  return {
    content: [
      `${subject} has been removed from VIA.`,
      '',
      'This is not going ahead, and nothing further will be posted about it.',
    ].join('\n'),
    components: [],
  };
}

/** Kept for the handlers, which describe a headline the same way in their logs. */
export { headlineFor };
