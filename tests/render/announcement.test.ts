import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import {
  renderEventAnnouncement, renderSeriesAnnouncement, renderMoveNotice,
  renderCancellationNotice, renderRemovedAnnouncement, isMove,
} from '../../src/render/announcement.ts';
import type { Reply } from '../../src/discord/adapter.ts';
import type { ViaEvent, ViaSeries } from '../../src/via/client.ts';

/**
 * What an announcement says.
 *
 * An announcement is the event card with a line above it saying why it has
 * appeared, so that a channel reading it knows whether this is new or a
 * change. The rules the design states are here: a series is announced once,
 * with its pattern and its end date, rather than once per meeting; a change
 * says what changed and what it changed to; and an event that was removed
 * leaves an announcement that says so rather than one that still describes
 * something that is not happening.
 */

const WEBSITE = 'https://viaillinois.com';

function event(overrides: Partial<ViaEvent> = {}): ViaEvent {
  return {
    eventId: 10,
    rsoId: 1,
    rsoName: 'IEEE',
    title: 'General meeting',
    description: 'Bring a laptop.',
    startTime: '2026-09-10T18:00:00-05:00',
    endTime: '2026-09-10T19:00:00-05:00',
    isPrivate: false,
    cancelledAt: null,
    locationId: 5,
    building: 'Electrical & Computer Eng Bldg',
    roomNumber: '1002',
    locationText: null,
    locationNote: null,
    seriesId: null,
    seriesFrequency: null,
    seriesIntervalWeeks: null,
    seriesDaysOfWeek: null,
    seriesEndsOn: null,
    interestCount: 3,
    ...overrides,
  };
}

const series: ViaSeries = {
  seriesId: 4,
  rsoId: 1,
  frequency: 'weekly',
  intervalWeeks: 1,
  daysOfWeek: 'MO,WE',
  startsOn: '2026-09-07',
  endsOn: '2026-12-09',
  startOfDay: '18:00:00',
  durationMinutes: 60,
};

function everyString(reply: Reply): string[] {
  const strings = [reply.content];
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'button') strings.push(component.label);
    }
  }
  return strings;
}

async function expectNoLanguageViolations(strings: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'via-bot-announcement-'));
  try {
    const path = join(dir, 'strings.txt');
    await writeFile(path, strings.join('\n') + '\n');
    expect(findViolations([path])).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the announcement of a new event', () => {
  const announcement = (overrides: Partial<ViaEvent> = {}) =>
    renderEventAnnouncement(event(overrides), { websiteUrl: WEBSITE });

  it('says which organization the event belongs to, above the card', () => {
    const { content } = announcement();
    expect(content.split('\n')[0]).toContain('IEEE');
    expect(content).toContain('General meeting');
  });

  it('says only that the event is new when the entry named no organization', () => {
    const { content } = announcement({ rsoName: null });
    expect(content.split('\n')[0]!.length).toBeGreaterThan(0);
    expect(content).toContain('General meeting');
  });

  it('carries the same buttons as the card, so a reader can act on it where it is', () => {
    const ids = (announcement().components ?? []).flatMap(row =>
      row.components.map(component => (component.kind === 'button' ? component.customId ?? component.url : '')));
    expect(ids).toContain('event:interested:10');
    expect(ids).toContain('event:remind:10');
  });

  it('writes the time on the campus clock with Discord\u2019s relative timestamp beside it', () => {
    const { content } = announcement();
    expect(content).toContain('6:00 PM');
    expect(content).toMatch(/<t:\d+:R>/);
  });

  it('passes the language check on every string it shows', async () => {
    await expectNoLanguageViolations(everyString(announcement()));
  });
});

describe('the announcement of a series', () => {
  const announcement = (overrides: Partial<ViaEvent> = {}) =>
    renderSeriesAnnouncement(event({ seriesId: 4, ...overrides }), series, { websiteUrl: WEBSITE });

  it('is one announcement about a set of meetings rather than one about an event', () => {
    const { content } = announcement();
    expect(content.split('\n')[0]).toContain('meetings');
  });

  it('says the pattern the meetings repeat on and the date they end', () => {
    const { content } = announcement();
    expect(content).toContain('every week');
    expect(content).toContain('Monday');
    expect(content).toContain('Wednesday');
    expect(content).toContain('Dec 9');
  });

  it('says the pattern from the series even when the event does not carry it', () => {
    const { content } = renderSeriesAnnouncement(
      event({ seriesId: null }),
      series,
      { websiteUrl: WEBSITE },
    );
    expect(content).toContain('every week');
    expect(content).toContain('Dec 9');
  });

  it('names the first meeting, so a reader knows when the series starts', () => {
    const { content } = announcement();
    expect(content).toContain('Sep 10');
  });

  it('passes the language check on every string it shows', async () => {
    await expectNoLanguageViolations(everyString(announcement()));
  });
});

describe('the notice that follows a change', () => {
  it('recognises a change of time and a change of place as a move', () => {
    expect(isMove(['start_time', 'end_time'])).toBe(true);
    expect(isMove(['location_id'])).toBe(true);
    expect(isMove(['building', 'room_number'])).toBe(true);
    expect(isMove(['description'])).toBe(false);
    expect(isMove([])).toBe(false);
  });

  it('says the event has moved to a new time, and names it', () => {
    const notice = renderMoveNotice(event({ startTime: '2026-09-11T19:00:00-05:00' }), ['start_time']);
    expect(notice).toContain('General meeting');
    expect(notice).toContain('7:00 PM');
    expect(notice).toMatch(/<t:\d+:R>/);
  });

  it('says the event has changed room, and names the room', () => {
    const notice = renderMoveNotice(
      event({ building: 'Everitt Laboratory', roomNumber: '151' }),
      ['location_id'],
    );
    expect(notice).toContain('Everitt Laboratory 151');
  });

  it('says both when both changed', () => {
    const notice = renderMoveNotice(
      event({ building: 'Everitt Laboratory', roomNumber: '151' }),
      ['start_time', 'location_id'],
    );
    expect(notice).toContain('Everitt Laboratory 151');
    expect(notice).toContain('6:00 PM');
  });

  it('says an event has been cancelled and that it is not going ahead', () => {
    const notice = renderCancellationNotice(event({ cancelledAt: '2026-09-05T12:00:00-05:00' }));
    expect(notice).toContain('General meeting');
    expect(notice.toLowerCase()).toContain('cancelled');
  });

  it('passes the language check on every notice', async () => {
    await expectNoLanguageViolations([
      renderMoveNotice(event(), ['start_time']),
      renderMoveNotice(event(), ['location_id']),
      renderMoveNotice(event(), ['start_time', 'building']),
      renderCancellationNotice(event({ cancelledAt: '2026-09-05T12:00:00-05:00' })),
    ]);
  });
});

describe('the announcement of something that was removed', () => {
  it('says the event was removed, and carries no buttons to act on it with', () => {
    const reply = renderRemovedAnnouncement('General meeting');
    expect(reply.content).toContain('General meeting');
    expect(reply.content.toLowerCase()).toContain('removed');
    expect(reply.components ?? []).toEqual([]);
  });

  it('says the meetings were removed when it does not know what they were called', () => {
    const reply = renderRemovedAnnouncement(null);
    expect(reply.content.toLowerCase()).toContain('removed');
  });

  it('passes the language check', async () => {
    await expectNoLanguageViolations([
      ...everyString(renderRemovedAnnouncement('General meeting')),
      ...everyString(renderRemovedAnnouncement(null)),
    ]);
  });
});
