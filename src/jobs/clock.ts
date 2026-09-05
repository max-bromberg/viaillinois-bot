import { campusDatePlus, campusStamp, campusToday, toInstant } from '../render/campusTime.ts';

/**
 * The clock the scheduled jobs share.
 *
 * Everything a job decides is decided on the campus clock, because that is the
 * clock a server manager chose their digest hour on and the clock a student
 * turns up at an event on. The readings themselves come from
 * src/render/campusTime.ts, which is the one place that knows how the campus
 * zone works, and this module only asks that module the questions a job has:
 * which hour is it, which day of the week is it, and which Sunday does this
 * week begin on.
 *
 * Two rules follow from a clock that moves twice a year. A day is not always
 * twenty four hours long, so a day is counted on the calendar rather than by
 * adding milliseconds, which campusDatePlus already does. An hour is always an
 * hour, so the hours a bot that was down has to catch up on are counted as
 * instants, which is what hoursBetween does.
 */

/** The days of the week, from Sunday, as User_Preferences and Guild_Installations count them. */
export const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** One hour, in milliseconds, which is the one duration that is always what it says. */
export const HOUR_MS = 60 * 60 * 1000;

/** The hour on the campus clock, from zero to twenty three. */
export function campusHour(at: Date): number {
  return Number(campusStamp(at).slice(11, 13));
}

/** The day of the week on campus, zero for Sunday, as the digest day counts. */
export function campusDayOfWeek(at: Date): number {
  return new Date(`${campusToday(at)}T00:00:00Z`).getUTCDay();
}

/** The Sunday the campus week containing this instant began on, as YYYY-MM-DD. */
export function campusWeekStart(at: Date): string {
  return campusDatePlus(-campusDayOfWeek(at), at);
}

/** The campus hour an instant falls in, in the shape a datetime column holds. */
export function campusHourStamp(at: Date): string {
  return `${campusStamp(at).slice(0, 13)}:00:00`;
}

/**
 * The instant the campus hour began.
 *
 * On the one hour a year that the campus clock repeats, a wall clock reading
 * names two instants and this answers the first of them. Nothing is lost by
 * that: the scheduler counts its catch up in instants, so the second reading
 * of the repeated hour is an hour of its own to it either way.
 */
export function campusHourStart(at: Date): Date {
  return toInstant(campusHourStamp(at)) ?? at;
}

/** How many whole hours passed between two instants, and never fewer than none. */
export function hoursBetween(from: Date, to: Date): number {
  const elapsed = to.getTime() - from.getTime();
  return elapsed <= 0 ? 0 : Math.floor(elapsed / HOUR_MS);
}

/**
 * An hour of the campus clock in the words a person picking one reads, so that
 * a menu of twenty four entries reads as a day rather than as a list of
 * numbers.
 */
export function describeHour(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'midday';
  if (hour < 12) return `${hour} in the morning`;
  if (hour < 18) return `${hour - 12} in the afternoon`;
  if (hour < 21) return `${hour - 12} in the evening`;
  return `${hour - 12} at night`;
}
