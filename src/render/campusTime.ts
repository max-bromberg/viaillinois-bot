/**
 * Campus time.
 *
 * VIA serves one campus, so every time the bot shows is that campus's clock,
 * which is what the website shows and what a student turns up at. Beside it
 * the bot puts Discord's own relative timestamp, which each reader's client
 * renders in their own words and their own zone, so a student reading from
 * home over the winter break still knows how far away the event is.
 *
 * This mirrors client/src/lib/campusTime.js on the web platform, and reads
 * times the same way: a reading that carries an offset names an instant, and a
 * bare wall clock reading is campus time, because that is what it is.
 */

export const CAMPUS_TIME_ZONE = 'America/Chicago';

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const FIELD_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPUS_TIME_ZONE,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPUS_TIME_ZONE,
  weekday: 'short', month: 'short', day: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: CAMPUS_TIME_ZONE,
  hour: 'numeric', minute: '2-digit',
});

/** Some builds separate the hour from AM or PM with a narrow space. */
const tidy = (text: string) => text.replace(/[  ]/g, ' ');

interface CampusFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function fieldsOf(instant: Date): CampusFields {
  const parts: Record<string, string> = {};
  for (const part of FIELD_FORMAT.formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Under hour12: false, midnight is reported as hour 24.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMinutesAt(instant: Date): number {
  const f = fieldsOf(instant);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return (asUtc - instant.getTime()) / 60_000;
}

/** Read a stored or published time as the instant it names, or null when it is not one. */
export function toInstant(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // A date on its own names a campus day, which is what the reading router
  // means by it too. Read as an instant instead it would be UTC midnight,
  // which is the day before on campus.
  const text = DATE_ONLY.test(value) ? `${value}T00:00:00` : value;

  const bare = WALL_CLOCK.exec(text);
  if (bare) {
    // A wall clock reading with no zone is campus time. Its offset depends on
    // the instant and the instant depends on the offset, so one guess and one
    // correction settle it, everywhere except inside the hour that does not
    // exist on the spring forward day.
    const [, y, mo, d, h, mi, s] = bare;
    const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    const offset = offsetMinutesAt(new Date(guess - offsetMinutesAt(new Date(guess)) * 60_000));
    return new Date(guess - offset * 60_000);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The date on campus, as the website writes it. */
export function campusDate(value: string | Date | null | undefined): string {
  const instant = toInstant(value);
  return instant ? tidy(DATE_FORMAT.format(instant)) : '';
}

/** The time of day on campus, as the website writes it. */
export function campusTimeOfDay(value: string | Date | null | undefined): string {
  const instant = toInstant(value);
  return instant ? tidy(TIME_FORMAT.format(instant)) : '';
}

/** The date and the time of day on campus, in one line. */
export function campusDateTime(value: string | Date | null | undefined): string {
  const day = campusDate(value);
  return day ? `${day} at ${campusTimeOfDay(value)}` : '';
}

/**
 * Discord's relative timestamp, which every reader's client renders in their
 * own words: in three days, in an hour, and so on. It is written beside the
 * campus clock rather than instead of it, because the campus clock is the
 * hour to turn up at and the relative timestamp is how far away that is.
 */
export function relativeTimestamp(value: string | Date | null | undefined): string {
  const instant = toInstant(value);
  return instant ? `<t:${Math.floor(instant.getTime() / 1000)}:R>` : '';
}

function isoDay(fields: CampusFields): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`;
}

/** Today on campus, as YYYY-MM-DD, which is the shape the reading router parses. */
export function campusToday(now: Date = new Date()): string {
  return isoDay(fieldsOf(now));
}

/**
 * The campus wall clock in the shape a datetime column holds, which is what
 * every datetime the bot writes is. The database keeps campus time, as the web
 * platform's does, so a row written here and a row written there read the same.
 */
export function campusStamp(now: Date = new Date()): string {
  const fields = fieldsOf(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${isoDay(fields)} ${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}`;
}

/**
 * The campus wall clock to the minute, as a form holds it.
 *
 * A modal that moves a meeting is filled in with the time the meeting runs at
 * now, and what the person sends back is read by the web platform's own wall
 * clock reader, which takes a date and a time with or without seconds. So this
 * is the one place both sides agree on, and it is written here beside the rest
 * of the campus clock rather than in the command that shows the box.
 */
export function campusWallClock(value: string | Date | null | undefined): string {
  const instant = toInstant(value);
  return instant ? campusStamp(instant).slice(0, 16) : '';
}

/** The windows the events command offers, named as its options name them. */
export type ListingWindow = 'today' | 'thisweek' | 'nextweek' | 'thismonth';

export interface WindowRange {
  from?: string;
  to?: string;
}

/**
 * Days are counted on a calendar rather than by adding milliseconds to an
 * instant, because a day is not always twenty four hours long on a clock that
 * moves twice a year, and the answer here is a campus date rather than a
 * moment.
 */
function addDays(fields: CampusFields, days: number): CampusFields {
  const moved = new Date(Date.UTC(fields.year, fields.month - 1, fields.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: 0, minute: 0, second: 0,
  };
}

/**
 * The campus date a number of days from today, as YYYY-MM-DD. The mirroring
 * window is counted with this rather than by adding milliseconds, because a
 * day is not always twenty four hours long on a clock that moves twice a year.
 */
export function campusDatePlus(days: number, now: Date = new Date()): string {
  return isoDay(addDays(fieldsOf(now), days));
}

/** Which day of the week a campus date falls on, zero for Sunday, as the digest day counts. */
function dayOfWeek(fields: CampusFields): number {
  return new Date(Date.UTC(fields.year, fields.month - 1, fields.day)).getUTCDay();
}

/**
 * The range of campus dates a window covers.
 *
 * Weeks run from Sunday to Saturday, as the digest day does in
 * User_Preferences and as the website's calendar draws them. Every window
 * except next week begins today rather than at the start of the period,
 * because a listing of what is coming up has nothing to say about yesterday.
 */
export function windowRange(window: ListingWindow | null | undefined, now: Date = new Date()): WindowRange {
  if (!window) return {};
  const today = fieldsOf(now);
  const from = isoDay(today);

  if (window === 'today') return { from, to: from };

  if (window === 'thisweek') {
    return { from, to: isoDay(addDays(today, 6 - dayOfWeek(today))) };
  }

  if (window === 'nextweek') {
    const sunday = addDays(today, 7 - dayOfWeek(today));
    return { from: isoDay(sunday), to: isoDay(addDays(sunday, 6)) };
  }

  // The zeroth day of the month after this one is the last day of this one.
  const lastDay = new Date(Date.UTC(today.year, today.month, 0));
  return { from, to: isoDay({
    year: lastDay.getUTCFullYear(),
    month: lastDay.getUTCMonth() + 1,
    day: lastDay.getUTCDate(),
    hour: 0, minute: 0, second: 0,
  }) };
}
