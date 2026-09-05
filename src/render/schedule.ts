import { campusDateTime, campusTimeOfDay, campusWallClock } from './campusTime.ts';
import { encodeAsk, encodeProposal, POLL_PREFIX, type Proposal, type ScheduleAsk } from '../scheduler/proposal.ts';
import type { ScheduleCandidate } from '../via/client.ts';
import type { Reply, ReplyButton, ReplyRow } from '../discord/adapter.ts';

/**
 * What the scheduler shows.
 *
 * The dashboard draws a table of evenings with their scores and the reasons
 * behind each one. Discord has no table, so the same answer is a numbered list
 * with one line per evening and its reasons under it, and the buttons are what
 * a board member does next: open a poll over the top few, or accept one.
 *
 * Nothing here weighs an evening. The score, the number of clear weeks and the
 * reasons are the web platform's own words, drawn as they arrived.
 */

/** How many evenings a message offers, which is what Discord will carry in one row of buttons. */
export const SHOWN_CANDIDATES = 5;

/** How many evenings a poll offers, so that members have a choice they can read. */
export const POLLED_CANDIDATES = 5;

/** How long the answers of a Discord poll may be. */
export const MAX_POLL_ANSWER = 55;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** How the hours a search was bounded by read in a sentence. */
export function describeWindow(ask: ScheduleAsk): string {
  const hour = (value: number) => campusTimeOfDay(`2026-01-01 ${String(value).padStart(2, '0')}:00:00`);
  return `between ${hour(ask.earliestHour)} and ${hour(ask.latestHour)}`;
}

/** Where an evening is, in the words the card uses for a room. */
export function placeOfCandidate(candidate: ScheduleCandidate): string {
  const room = [candidate.building, candidate.roomNumber].filter(Boolean).join(' ');
  return room || 'a room VIA did not name';
}

/** Which day of the week a campus date falls on, written out. */
function weekdayOf(startTime: string): string {
  const date = campusWallClock(startTime).slice(0, 10);
  if (!date) return '';
  return WEEKDAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? '';
}

/**
 * One evening in a line. A repeat is written as the weekday it falls on,
 * because a board choosing a weekly meeting is choosing a weekday and an hour
 * rather than a date, and a search over one week is written as the date it
 * actually is.
 */
export function describeCandidate(candidate: ScheduleCandidate): string {
  const time = campusTimeOfDay(candidate.startTime);
  const repeats = (candidate.intervalWeeks ?? 0) > 0;
  const when = repeats
    ? `${weekdayOf(candidate.startTime)}s at ${time}`
    : campusDateTime(candidate.startTime);
  return `${when}, ${placeOfCandidate(candidate)}`;
}

/** The same line, cut to what a poll answer will hold. */
export function pollAnswerFor(candidate: ScheduleCandidate): string {
  const line = describeCandidate(candidate);
  return line.length <= MAX_POLL_ANSWER ? line : `${line.slice(0, MAX_POLL_ANSWER - 3).trimEnd()}...`;
}

/** The evening a message offered, in the shape a button carries. */
export function proposalOf(candidate: ScheduleCandidate, ask: ScheduleAsk): Proposal {
  return {
    ask,
    // The T is what tells a date from a time inside an identifier whose parts
    // are already separated by something else.
    startTime: campusWallClock(candidate.startTime).replace(' ', 'T'),
    locationId: candidate.locationId,
    intervalWeeks: candidate.intervalWeeks ?? 0,
    until: candidate.until ?? '',
    score: candidate.score,
  };
}

/** How the weeks a repeat is clear for read, when the search was about a repeat. */
export function describeWeeks(candidate: ScheduleCandidate): string | null {
  if (candidate.weeksTotal === null || candidate.weeksClear === null) return null;
  return `The room is free for ${candidate.weeksClear} of ${candidate.weeksTotal} weeks.`;
}

export interface RecommendationView {
  rsoName: string;
  ask: ScheduleAsk;
  candidates: readonly ScheduleCandidate[];
}

export const NOTHING_RECOMMENDED_MESSAGE =
  'VIA found nothing that fits inside those hours. Try a wider window of the day, a shorter meeting, or the coming week rather than the whole term.';

/** The recommendations, with a button to poll over them and one to accept each. */
export function renderRecommendations(view: RecommendationView): Reply {
  const shown = view.candidates.slice(0, SHOWN_CANDIDATES);
  if (shown.length === 0) {
    return { content: NOTHING_RECOMMENDED_MESSAGE, components: [] };
  }

  const lines = [
    `**When ${view.rsoName} could meet**`,
    '',
    `${view.ask.minutes} minutes, ${describeWindow(view.ask)}, ${view.ask.span === 'term' ? 'every week for the rest of the term' : 'in the coming week'}.`,
    '',
  ];

  shown.forEach((candidate, index) => {
    lines.push(`**${index + 1}.** ${describeCandidate(candidate)}, scoring ${candidate.score}`);
    const weeks = describeWeeks(candidate);
    if (weeks) lines.push(`  ${weeks}`);
    for (const reason of candidate.reasons) lines.push(`  ${reason}`);
  });

  const accepts: ReplyButton[] = shown.map((candidate, index) => ({
    kind: 'button',
    style: index === 0 ? 'primary' : 'secondary',
    label: `Accept ${index + 1}`,
    customId: encodeProposal(proposalOf(candidate, view.ask)),
  }));

  const rows: ReplyRow[] = [
    { kind: 'row', components: accepts },
    {
      kind: 'row',
      components: [{
        kind: 'button',
        style: 'secondary',
        label: 'Ask the members in a poll',
        customId: `${POLL_PREFIX}${encodeAsk(view.ask)}`,
      }],
    },
  ];

  return { content: lines.join('\n'), components: rows };
}
