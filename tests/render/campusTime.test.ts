import { describe, it, expect } from 'vitest';
import {
  campusDate, campusDateTime, campusTimeOfDay, campusToday, relativeTimestamp, windowRange,
} from '../../src/render/campusTime.ts';

/**
 * Campus time in Discord.
 *
 * VIA serves one campus, so every time the bot shows is that campus's clock,
 * exactly as the website shows it. Beside it goes Discord's own relative
 * timestamp, which every reader's client renders in their own words, so a
 * student reading from another time zone still knows how far away the event
 * is without having to work out what the campus clock means for them.
 */
describe('showing a time on the campus clock', () => {
  const start = '2026-09-10T18:00:00-05:00';

  it('writes the date the way the website writes it', () => {
    expect(campusDate(start)).toBe('Thu, Sep 10');
  });

  it('writes the time of day the way the website writes it', () => {
    expect(campusTimeOfDay(start)).toBe('6:00 PM');
  });

  it('writes the date and the time of day in one line', () => {
    expect(campusDateTime(start)).toBe('Thu, Sep 10 at 6:00 PM');
  });

  it('reads a campus wall clock reading with no offset as campus time', () => {
    expect(campusDateTime('2026-09-10 18:00:00')).toBe('Thu, Sep 10 at 6:00 PM');
  });

  it('shows the campus clock rather than the clock of whoever runs the bot', () => {
    // The same instant, written in another zone, is the same campus reading.
    expect(campusDateTime('2026-09-10T23:00:00Z')).toBe('Thu, Sep 10 at 6:00 PM');
  });

  it('reads a date on its own as that campus day, rather than the day before', () => {
    expect(campusDate('2026-12-09')).toBe('Wed, Dec 9');
  });

  it('writes nothing at all for a time that is not one', () => {
    expect(campusDateTime('')).toBe('');
    expect(campusDateTime('not a time')).toBe('');
  });

  it('writes the relative timestamp in the form Discord renders', () => {
    expect(relativeTimestamp(start)).toBe('<t:1789081200:R>');
  });

  it('writes no relative timestamp for a time that is not one', () => {
    expect(relativeTimestamp('not a time')).toBe('');
  });

  it('reads today on campus, which is the day before midnight in Illinois', () => {
    // Three in the morning UTC is ten in the evening of the day before on campus.
    expect(campusToday(new Date('2026-09-11T03:00:00Z'))).toBe('2026-09-10');
  });
});

/**
 * The four windows the events command offers. Weeks run from Sunday to
 * Saturday, as the digest day does in User_Preferences and as the website's
 * calendar draws them, and every window begins today rather than in the past,
 * because a listing of what is coming up has nothing to say about yesterday.
 */
describe('the window a listing asks for', () => {
  // A Thursday on campus.
  const thursday = new Date('2026-09-10T17:00:00Z');

  it('asks for one day when the window is today', () => {
    expect(windowRange('today', thursday)).toEqual({ from: '2026-09-10', to: '2026-09-10' });
  });

  it('asks for the rest of this week, up to the Saturday', () => {
    expect(windowRange('thisweek', thursday)).toEqual({ from: '2026-09-10', to: '2026-09-12' });
  });

  it('asks for the whole of the week after this one', () => {
    expect(windowRange('nextweek', thursday)).toEqual({ from: '2026-09-13', to: '2026-09-19' });
  });

  it('asks for the rest of this month', () => {
    expect(windowRange('thismonth', thursday)).toEqual({ from: '2026-09-10', to: '2026-09-30' });
  });

  it('counts the week as ending on the Saturday even when today is one', () => {
    const saturday = new Date('2026-09-12T17:00:00Z');
    expect(windowRange('thisweek', saturday)).toEqual({ from: '2026-09-12', to: '2026-09-12' });
    expect(windowRange('nextweek', saturday)).toEqual({ from: '2026-09-13', to: '2026-09-19' });
  });

  it('counts the week from the Sunday, so a Sunday is the first day of its own week', () => {
    const sunday = new Date('2026-09-13T17:00:00Z');
    expect(windowRange('thisweek', sunday)).toEqual({ from: '2026-09-13', to: '2026-09-19' });
    expect(windowRange('nextweek', sunday)).toEqual({ from: '2026-09-20', to: '2026-09-26' });
  });

  it('runs to the end of February in a leap year and to the day before in another', () => {
    expect(windowRange('thismonth', new Date('2028-02-10T17:00:00Z')).to).toBe('2028-02-29');
    expect(windowRange('thismonth', new Date('2026-02-10T17:00:00Z')).to).toBe('2026-02-28');
  });

  it('asks for nothing in particular when no window was named', () => {
    expect(windowRange(null, thursday)).toEqual({});
  });
});
