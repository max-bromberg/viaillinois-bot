import { describe, it, expect } from 'vitest';
import {
  WEEKDAY_NAMES, campusDayOfWeek, campusHour, campusHourStamp, campusHourStart,
  campusWeekStart, describeHour, hoursBetween,
} from '../../src/jobs/clock.ts';

/**
 * The clock the scheduled jobs share.
 *
 * Everything a job decides is decided on the campus clock: whether this is the
 * hour a server chose for its digest, which week a digest covers, and how many
 * hours a bot that was down has to catch up on. The instants below are fixed,
 * so every claim here is a claim about one moment rather than about the moment
 * the test happens to run at.
 */
describe('the campus clock the jobs run on', () => {
  const SATURDAY_MORNING = new Date('2026-09-05T14:37:12Z');

  it('reads the hour on the campus clock rather than in UTC', () => {
    expect(campusHour(SATURDAY_MORNING)).toBe(9);
  });

  it('reads midnight on campus as hour zero', () => {
    expect(campusHour(new Date('2026-09-05T05:10:00Z'))).toBe(0);
  });

  it('counts the days of the week from Sunday, as the digest day does', () => {
    expect(campusDayOfWeek(SATURDAY_MORNING)).toBe(6);
    expect(campusDayOfWeek(new Date('2026-09-06T14:00:00Z'))).toBe(0);
    expect(campusDayOfWeek(new Date('2026-09-07T14:00:00Z'))).toBe(1);
  });

  it('reads the day of the week on the campus clock, not in UTC', () => {
    // Late on Saturday evening on campus is already Sunday in UTC.
    expect(campusDayOfWeek(new Date('2026-09-06T02:00:00Z'))).toBe(6);
  });

  it('begins a week on the Sunday of that week', () => {
    expect(campusWeekStart(SATURDAY_MORNING)).toBe('2026-08-30');
    expect(campusWeekStart(new Date('2026-09-06T14:00:00Z'))).toBe('2026-09-06');
  });

  it('names the hour a job is running for, on the campus clock', () => {
    expect(campusHourStamp(SATURDAY_MORNING)).toBe('2026-09-05 09:00:00');
  });

  it('answers the instant the campus hour began', () => {
    expect(campusHourStart(SATURDAY_MORNING).toISOString()).toBe('2026-09-05T14:00:00.000Z');
  });

  /**
   * A day is not always twenty four hours long on a clock that moves twice a
   * year, so the hours a bot that was down has to catch up on are counted as
   * instants rather than as wall clock readings.
   */
  it('counts the hours between two instants', () => {
    expect(hoursBetween(new Date('2026-09-05T14:00:00Z'), new Date('2026-09-05T17:00:00Z'))).toBe(3);
    expect(hoursBetween(new Date('2026-09-05T17:00:00Z'), new Date('2026-09-05T14:00:00Z'))).toBe(0);
  });

  it('counts the hours across the day the clocks go forward, which is twenty three hours long', () => {
    // Midnight to midnight on campus, over the spring forward Sunday.
    const from = new Date('2026-03-08T06:00:00Z');
    const to = new Date('2026-03-09T05:00:00Z');
    expect(hoursBetween(from, to)).toBe(23);
  });

  it('names each day of the week the way a person choosing one reads it', () => {
    expect(WEEKDAY_NAMES[0]).toBe('Sunday');
    expect(WEEKDAY_NAMES[6]).toBe('Saturday');
    expect(WEEKDAY_NAMES).toHaveLength(7);
  });

  it('writes an hour of the campus clock the way a person choosing one reads it', () => {
    expect(describeHour(0)).toBe('midnight');
    expect(describeHour(9)).toBe('9 in the morning');
    expect(describeHour(12)).toBe('midday');
    expect(describeHour(18)).toBe('6 in the evening');
    expect(describeHour(23)).toBe('11 at night');
  });
});
