import { describe, it, expect } from 'vitest';
import { describePattern } from '../../src/render/eventCard.ts';

/**
 * What a repeat says on a card.
 *
 * The web platform used to hold one shape of repeat, every so many weeks on the
 * days chosen, so the sentence only had to describe that one. It now also holds
 * a monthly rule, in both of the forms that phrase means, and a set of dates an
 * organizer picked one by one, and a card that called all three "every week"
 * would be telling a student the wrong thing about when to turn up.
 *
 * The days themselves arrive as VIA writes them, which is Sun through Sat.
 */
describe('describePattern, every so many weeks', () => {
  it('says the days it runs on and when it stops', () => {
    expect(describePattern({
      frequency: 'weekly', intervalWeeks: 1, daysOfWeek: 'Tue', endsOn: '2026-12-08',
    })).toBe('This meeting repeats every week on Tuesday, until Tue, Dec 8.');
  });

  it('reads more than one day as a sentence', () => {
    expect(describePattern({
      frequency: 'weekly', intervalWeeks: 1, daysOfWeek: 'Tue,Thu', endsOn: null,
    })).toBe('This meeting repeats every week on Tuesday and Thursday.');
  });

  it('says how many weeks apart when it is more than one', () => {
    expect(describePattern({
      frequency: 'weekly', intervalWeeks: 3, daysOfWeek: 'Tue', endsOn: null,
    })).toBe('This meeting repeats every 3 weeks on Tuesday.');
  });

  /** A calendar file writes them as two letters, and one of ours might yet. */
  it('still reads the two letter form a calendar file writes', () => {
    expect(describePattern({
      frequency: 'weekly', intervalWeeks: 1, daysOfWeek: 'TU', endsOn: null,
    })).toBe('This meeting repeats every week on Tuesday.');
  });
});

describe('describePattern, once a month', () => {
  it('says which date of the month', () => {
    expect(describePattern({
      frequency: 'monthly', intervalMonths: 1, monthDay: 15, endsOn: '2026-12-15',
    })).toBe('This meeting repeats on the 15th of each month, until Tue, Dec 15.');
  });

  it('says which weekday of the month', () => {
    expect(describePattern({
      frequency: 'monthly', intervalMonths: 1, monthWeek: 2, daysOfWeek: 'Tue', endsOn: null,
    })).toBe('This meeting repeats on the second Tuesday of each month.');
  });

  it('says the last one when that is the position', () => {
    expect(describePattern({
      frequency: 'monthly', intervalMonths: 1, monthWeek: -1, daysOfWeek: 'Fri', endsOn: null,
    })).toBe('This meeting repeats on the last Friday of each month.');
  });

  it('says how many months apart when it is more than one', () => {
    expect(describePattern({
      frequency: 'monthly', intervalMonths: 3, monthDay: 15, endsOn: null,
    })).toBe('This meeting repeats on the 15th of every 3 months.');
  });
});

describe('describePattern, on dates chosen one by one', () => {
  it('says there is no rule, and names the last of them', () => {
    expect(describePattern({
      frequency: 'dates', daysOfWeek: 'Thu', endsOn: '2026-10-08',
    })).toBe('This meeting repeats on dates chosen one by one, the last on Thu, Oct 8.');
  });

  it('says as much as it can when there is no last date', () => {
    expect(describePattern({ frequency: 'dates', daysOfWeek: null, endsOn: null }))
      .toBe('This meeting repeats on dates chosen one by one.');
  });
});

/** A series from before the platform held a frequency reads as it always did. */
describe('describePattern, a rule that names no shape', () => {
  it('reads as the weekly rule it was', () => {
    expect(describePattern({ intervalWeeks: 2, daysOfWeek: 'Tue', endsOn: null }))
      .toBe('This meeting repeats every 2 weeks on Tuesday.');
  });
});
