import { describe, it, expect } from 'vitest';
import {
  DIGEST_STOP_SENTENCE, MAX_MESSAGE_LENGTH, REMINDER_STOP_SENTENCE, REST_OF_THE_WEEK,
  digestLine, fitToMessage, groupByCampusDay, renderDayOfReminder, renderGuildDigest,
  renderPersonalDigest, renderPersonalReminder, renderThisWeek,
} from '../../src/render/digest.ts';
import type { ViaEvent } from '../../src/via/client.ts';

/**
 * The weekly digest, the reminders and the living this week message.
 *
 * All four are the same list of events written for a different reader, so they
 * are one module and one grouping. Two rules from the design are tested here.
 * The week is grouped by day, because a list of thirty events in one column is
 * not a week anybody can read. And every direct message ends with the way to
 * stop that kind of message, which sections 9 and 10 require.
 */
function event(overrides: Partial<ViaEvent> = {}): ViaEvent {
  return {
    eventId: 10,
    rsoId: 3,
    rsoName: 'IEEE',
    title: 'General meeting',
    description: null,
    startTime: '2026-09-07T18:00:00-05:00',
    endTime: '2026-09-07T19:00:00-05:00',
    isPrivate: false,
    cancelledAt: null,
    locationId: 1,
    building: 'ECEB',
    roomNumber: '1002',
    locationText: null,
    locationNote: null,
    seriesId: null,
    seriesFrequency: null,
    seriesIntervalWeeks: null,
    seriesDaysOfWeek: null,
    seriesEndsOn: null,
    interestCount: 0,
    ...overrides,
  };
}

describe('grouping a week by day', () => {
  it('puts the events of one campus day together, in the order they happen', () => {
    const groups = groupByCampusDay([
      event({ eventId: 2, startTime: '2026-09-07T20:00:00-05:00', title: 'Later' }),
      event({ eventId: 3, startTime: '2026-09-09T12:00:00-05:00', title: 'Wednesday' }),
      event({ eventId: 1, startTime: '2026-09-07T18:00:00-05:00', title: 'Earlier' }),
    ]);

    expect(groups.map(group => group.day)).toEqual(['2026-09-07', '2026-09-09']);
    expect(groups[0]!.events.map(one => one.title)).toEqual(['Earlier', 'Later']);
    expect(groups[0]!.label).toBe('Mon, Sep 7');
  });

  it('groups on the campus day rather than the UTC day', () => {
    // Nine in the evening on campus is already the next day in UTC.
    const groups = groupByCampusDay([event({ startTime: '2026-09-07T21:00:00-05:00' })]);
    expect(groups[0]!.day).toBe('2026-09-07');
  });

  it('leaves out an event whose start VIA did not send', () => {
    expect(groupByCampusDay([event({ startTime: '' })])).toEqual([]);
  });
});

describe('one event on a line of a digest', () => {
  it('writes the time of day, the title, the organization and the room', () => {
    const line = digestLine(event());
    expect(line).toContain('6:00 PM');
    expect(line).toContain('General meeting');
    expect(line).toContain('IEEE');
    expect(line).toContain('ECEB 1002');
  });

  it('marks an event that has been cancelled, because the row is still worth reading', () => {
    expect(digestLine(event({ cancelledAt: '2026-09-06T09:00:00-05:00' }))).toContain('cancelled');
  });

  it('says so when the place has not been announced', () => {
    expect(digestLine(event({ building: null, roomNumber: null }))).toContain('not been announced');
  });
});

describe('the personal digest', () => {
  const week = { weekStart: '2026-09-06', events: [event()] };

  it('lists the week grouped by day', () => {
    const content = renderPersonalDigest(week);
    expect(content).toContain('Mon, Sep 7');
    expect(content).toContain('General meeting');
  });

  it('ends with the way to stop this kind of message', () => {
    expect(renderPersonalDigest(week).endsWith(DIGEST_STOP_SENTENCE)).toBe(true);
  });

  it('says plainly that a week with nothing in it has nothing in it', () => {
    const content = renderPersonalDigest({ weekStart: '2026-09-06', events: [] });
    expect(content).toContain('nothing coming up');
    expect(content.endsWith(DIGEST_STOP_SENTENCE)).toBe(true);
  });
});

describe('a personal reminder', () => {
  it('names the event, when it starts and where it is', () => {
    const content = renderPersonalReminder(event(), 60);
    expect(content).toContain('General meeting');
    expect(content).toContain('ECEB 1002');
    expect(content).toContain('6:00 PM');
  });

  it('ends with the way to stop this kind of message', () => {
    expect(renderPersonalReminder(event(), 60).endsWith(REMINDER_STOP_SENTENCE)).toBe(true);
  });
});

describe('the digest a server posts', () => {
  it('names the week and lists it by day', () => {
    const reply = renderGuildDigest({ weekStart: '2026-09-06', events: [event()] });
    expect(reply.content).toContain('Mon, Sep 7');
    expect(reply.content).toContain('General meeting');
  });

  it('says plainly that a week with nothing in it has nothing in it', () => {
    const reply = renderGuildDigest({ weekStart: '2026-09-06', events: [] });
    expect(reply.content).toContain('nothing coming up');
  });

  /**
   * A digest in a channel is not a direct message, so it carries no way to
   * stop it: what stops it is the server manager switching the feature off.
   */
  it('carries no personal opt out, because a channel is not a direct message', () => {
    const reply = renderGuildDigest({ weekStart: '2026-09-06', events: [event()] });
    expect(reply.content).not.toContain(DIGEST_STOP_SENTENCE);
  });
});

describe('the day of reminder a server posts', () => {
  it('names the event, the hour and the place, and links to the card', () => {
    const reply = renderDayOfReminder(event(), { websiteUrl: 'https://viaillinois.com' });
    expect(reply.content).toContain('General meeting');
    expect(reply.content).toContain('ECEB 1002');
    expect(reply.components![0]!.components[0]).toMatchObject({
      url: 'https://viaillinois.com/events/10',
    });
  });
});

describe('the living this week message', () => {
  it('names the week it covers and lists it by day', () => {
    const reply = renderThisWeek({
      weekStart: '2026-09-06',
      events: [event()],
      updatedAt: new Date('2026-09-06T23:00:00Z'),
    });
    expect(reply.content).toContain('This week');
    expect(reply.content).toContain('Mon, Sep 7');
  });

  /**
   * The message is edited in place rather than posted again, so it says when
   * it was last brought up to date. Without that, a reader cannot tell a week
   * with nothing in it from a bot that has stopped.
   */
  it('says when it was last brought up to date', () => {
    const reply = renderThisWeek({
      weekStart: '2026-09-06',
      events: [],
      updatedAt: new Date('2026-09-06T23:00:00Z'),
    });
    expect(reply.content).toContain('6:00 PM');
    expect(reply.content).toContain('nothing coming up');
  });
});

/**
 * What Discord will carry.
 *
 * A message longer than two thousand characters is refused outright, so a busy
 * week would be a digest nobody receives at all. The list is cut a whole day at
 * a time, because half a Tuesday reads as a fault, and the message says where
 * the rest of the week is.
 */
describe('fitting a week into one message', () => {
  const day = (label: string, rows: number) => [
    `**${label}**`,
    ...Array.from({ length: rows }, (_unused, index) => `- ${index}: ${'x'.repeat(80)}`),
  ];

  it('leaves a message that already fits exactly as it was', () => {
    const lines = { head: ['**A week**', ''], days: [day('Mon, Sep 7', 1)], tail: ['', 'Stop me.'] };
    expect(fitToMessage(lines)).toBe('**A week**\n\n**Mon, Sep 7**\n- 0: ' + 'x'.repeat(80) + '\n\nStop me.');
  });

  it('never answers with more than Discord will carry', () => {
    const lines = {
      head: ['**A week**', ''],
      days: [day('Mon', 10), day('Tue', 10), day('Wed', 10)],
      tail: ['', 'Stop me.'],
    };
    expect(fitToMessage(lines).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('drops whole days rather than half of one', () => {
    const lines = {
      head: ['**A week**', ''],
      days: [day('Mon', 10), day('Tue', 10), day('Wed', 10)],
    };
    const fitted = fitToMessage(lines);
    expect(fitted).toContain('**Mon**');
    expect(fitted).not.toContain('**Wed**');
    // Every row of a day that was kept is still there.
    expect(fitted.split('\n').filter(line => line.startsWith('- ')).length % 10).toBe(0);
  });

  it('says where the rest of the week is when it had to cut', () => {
    const lines = { head: ['**A week**', ''], days: [day('Mon', 10), day('Tue', 10), day('Wed', 10)] };
    expect(fitToMessage(lines).endsWith(REST_OF_THE_WEEK)).toBe(true);
  });

  it('keeps what comes after the list, because that is how a person stops the message', () => {
    const lines = {
      head: ['**A week**', ''],
      days: [day('Mon', 10), day('Tue', 10), day('Wed', 10)],
      tail: ['', DIGEST_STOP_SENTENCE],
    };
    expect(fitToMessage(lines)).toContain(DIGEST_STOP_SENTENCE);
  });

  it('cuts inside the one day it has when even that will not fit', () => {
    const lines = { head: ['**A week**', ''], days: [day('Mon', 40)] };
    const fitted = fitToMessage(lines);
    expect(fitted.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(fitted).toContain('**Mon**');
    expect(fitted.endsWith(REST_OF_THE_WEEK)).toBe(true);
  });

  it('cuts a message with no days in it at all rather than sending one Discord refuses', () => {
    const lines = { head: ['**A week**', 'y'.repeat(3000)], days: [] };
    expect(fitToMessage(lines).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});

/**
 * Every renderer that lists a week has to fit inside one message, because a
 * week that does not fit is a message Discord refuses outright.
 */
describe('the renderers that list a week', () => {
  const busyWeek = () => Array.from({ length: 120 }, (_unused, index) => event({
    eventId: index,
    title: `A meeting with quite a long title, number ${index}`,
    startTime: `2026-09-0${(index % 3) + 7}T18:00:00-05:00`,
    endTime: `2026-09-0${(index % 3) + 7}T19:00:00-05:00`,
  }));

  it('keeps the personal digest inside what Discord will carry', () => {
    const message = renderPersonalDigest({ weekStart: '2026-09-06', events: busyWeek() });
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(message).toContain(DIGEST_STOP_SENTENCE);
  });

  it('keeps the digest a server posts inside what Discord will carry', () => {
    const reply = renderGuildDigest({ weekStart: '2026-09-06', events: busyWeek() });
    expect(reply.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it('keeps the living this week message inside what Discord will carry', () => {
    const reply = renderThisWeek({
      weekStart: '2026-09-06',
      events: busyWeek(),
      updatedAt: new Date('2026-09-07T14:30:00Z'),
    });
    expect(reply.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(reply.content).toContain('Last brought up to date');
  });
});
