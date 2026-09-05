/**
 * What a recommendation message carries in its buttons.
 *
 * A board member can press an accept button on a message the bot posted a week
 * ago, in a server the bot has been restarted in twice since. Discord gives
 * back nothing but the identifier the button was built with, so the identifier
 * has to say everything the acceptance needs: which organization, what was
 * asked of the scheduler, and which evening this button stood for. Discord
 * allows a hundred characters for it, which is enough for all of that written
 * compactly, and holding it there rather than in a table means no state to
 * expire and nothing to clean up.
 *
 * The one thing that is not held in a button is what a poll offered, because a
 * poll offers several evenings at once and its answers come back as numbers.
 * That is what Scheduler_Polls is for.
 */

/** How far ahead a search looks: the coming week, or the rest of the term. */
export type ScheduleSpan = 'week' | 'term';

/** What a board asked the scheduler for. */
export interface ScheduleAsk {
  rsoId: number;
  span: ScheduleSpan;
  /** How long each meeting runs, in minutes. */
  minutes: number;
  /** The window of the campus day a meeting may run in. */
  earliestHour: number;
  latestHour: number;
}

/**
 * One evening a message offered. The start is campus wall clock to the minute,
 * and a search over one week repeats nothing, which is what an interval of
 * zero and an empty end date say.
 */
export interface Proposal {
  ask: ScheduleAsk;
  /** Campus wall clock, as YYYY-MM-DDTHH:MM. */
  startTime: string;
  locationId: number | null;
  intervalWeeks: number;
  /** The last date the repeat runs on, or empty for a search over one week. */
  until: string;
  /**
   * What the scheduler scored this evening when the message was written,
   * rounded to a whole number.
   *
   * It is carried so that accepting can tell an evening that still stands from
   * one the scheduler now thinks less of, which is what a board reading a day
   * old poll result needs to be told before a term of meetings is created. It
   * is rounded because an identifier is a string of digits: a score of 87.5
   * written in full is read back as nothing at all, which would be an Accept
   * button that never works.
   */
  score: number;
}

/** What the prefixes are, which is also how a handler tells them apart. */
export const POLL_PREFIX = 'sched:poll:';
export const POLL_IN_PREFIX = 'sched:pollin:';
export const TAKE_PREFIX = 'sched:take:';

/**
 * The button that opens the form asking what the repeat is called, and the
 * form itself.
 *
 * It carries the same evening the accept button carried, and it is a prefix of
 * its own because Discord takes a form only as the first thing said about an
 * interaction: accepting checks the recommendation again, which is a call to
 * the web platform and does not belong inside the three seconds a form has,
 * and opening the form has nothing behind it at all.
 */
export const NAME_PREFIX = 'sched:name:';

const SPANS: readonly string[] = ['week', 'term'];

function whole(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/** What was asked, written compactly enough to sit inside a button identifier. */
export function encodeAsk(ask: ScheduleAsk): string {
  return [ask.rsoId, ask.span, ask.minutes, ask.earliestHour, ask.latestHour].join('|');
}

export function decodeAsk(text: string): ScheduleAsk | null {
  const parts = text.split('|');
  if (parts.length !== 5) return null;
  const [rso, span, minutes, earliest, latest] = parts;

  const rsoId = whole(rso);
  const length = whole(minutes);
  const earliestHour = whole(earliest);
  const latestHour = whole(latest);
  if (rsoId === null || length === null || earliestHour === null || latestHour === null) return null;
  if (!SPANS.includes(span ?? '')) return null;

  return { rsoId, span: span as ScheduleSpan, minutes: length, earliestHour, latestHour };
}

const START_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The evening itself, without the prefix that says which button carries it. */
function encodeBody(proposal: Proposal): string {
  return [
    encodeAsk(proposal.ask),
    proposal.startTime,
    proposal.locationId === null ? '' : proposal.locationId,
    proposal.intervalWeeks,
    proposal.until,
    // A score is whatever the scheduler weighed it as, and nothing says that
    // is a whole number. The identifier carries whole numbers, so it is
    // rounded here and compared rounded wherever it is read.
    Math.round(proposal.score),
  ].join('|');
}

/** One evening, written into the identifier of the button that accepts it. */
export function encodeProposal(proposal: Proposal): string {
  return TAKE_PREFIX + encodeBody(proposal);
}

/**
 * The same evening, written into the button that opens the form asking what
 * the repeat is called, and into the form itself.
 */
export function encodeNaming(proposal: Proposal): string {
  return NAME_PREFIX + encodeBody(proposal);
}

export function decodeProposal(customId: string): Proposal | null {
  const prefix = [TAKE_PREFIX, NAME_PREFIX].find(one => customId.startsWith(one));
  if (!prefix) return null;
  const parts = customId.slice(prefix.length).split('|');
  if (parts.length !== 10) return null;

  const ask = decodeAsk(parts.slice(0, 5).join('|'));
  if (!ask) return null;

  const [startTime, location, interval, until, scored] = parts.slice(5);
  if (!START_TIME.test(startTime ?? '')) return null;
  const intervalWeeks = whole(interval);
  const score = whole(scored);
  if (intervalWeeks === null || score === null) return null;
  const locationId = location === '' ? null : whole(location);
  if (location !== '' && locationId === null) return null;
  if (until !== '' && !DATE.test(until ?? '')) return null;

  return { ask, startTime: startTime!, locationId, intervalWeeks, until: until!, score };
}
