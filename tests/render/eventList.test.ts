import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import { renderEventList, PAGE_SIZE } from '../../src/render/eventList.ts';
import type { ViaEvent } from '../../src/via/client.ts';

/**
 * The list of what is coming up.
 *
 * One message, one compact row per event, a page control, and a button per row
 * that opens the card. The rows carry the campus clock with Discord's relative
 * timestamp beside it, exactly as the card does, and the two markers that
 * change what an event means are on the row as well as on the card, because a
 * student reading a list should not have to open an event to find out it was
 * cancelled.
 */

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

function list(overrides: Partial<Parameters<typeof renderEventList>[0]> = {}) {
  return renderEventList({
    events: [event()],
    total: 1,
    offset: 0,
    heading: 'Coming up across ECE',
    previousId: null,
    nextId: null,
    openId: (one: ViaEvent) => `events:open:${one.eventId}`,
    ...overrides,
  });
}

describe('the list of what is coming up', () => {
  it('pages five events at a time, which leaves a row for the page control', () => {
    expect(PAGE_SIZE).toBe(5);
  });

  it('writes one compact row per event, numbered from one on every page', () => {
    const { content } = list({
      events: [event(), event({ eventId: 11, title: 'Tutoring' })],
      total: 2,
    });
    expect(content).toContain('1. ');
    expect(content).toContain('2. ');
    expect(content).toContain('General meeting');
    expect(content).toContain('Tutoring');
  });

  it('shows the campus clock with the relative timestamp beside it on every row', () => {
    const { content } = list();
    expect(content).toContain('Thu, Sep 10 at 6:00 PM');
    expect(content).toContain('<t:1789081200:R>');
  });

  it('names the organization on every row, since a list spans many of them', () => {
    expect(list().content).toContain('IEEE');
  });

  it('names the room on every row', () => {
    expect(list().content).toContain('Electrical & Computer Eng Bldg 1002');
  });

  it('marks an internal event on the row, not only on the card', () => {
    expect(list({ events: [event({ isPrivate: true })] }).content).toContain('internal');
  });

  it('marks a cancelled event on the row, so nobody turns up to it', () => {
    const { content } = list({ events: [event({ cancelledAt: '2026-09-08T09:00:00-05:00' })] });
    expect(content.toLowerCase()).toContain('cancelled');
  });

  it('gives every row a button that opens its card', () => {
    const { components } = list({
      events: [event(), event({ eventId: 11, title: 'Tutoring' })],
      total: 2,
    });
    const [rows] = components!;
    expect(rows!.components.map(c => (c.kind === 'button' ? c.customId : ''))).toEqual([
      'events:open:10', 'events:open:11',
    ]);
  });

  it('labels each button with the number of its row, so a row and a button match', () => {
    const { components } = list({
      events: [event(), event({ eventId: 11, title: 'Tutoring' })],
      total: 2,
    });
    const [rows] = components!;
    expect(rows!.components.map(c => (c.kind === 'button' ? c.label : ''))).toEqual(['1', '2']);
  });

  it('says which events of how many are being shown', () => {
    const { content } = list({ events: [event(), event({ eventId: 11 })], total: 9, offset: 5 });
    expect(content).toContain('6 to 7 of 9');
  });

  it('offers no page control at all when everything fits in one page', () => {
    const { components } = list();
    expect(components!.map(row => row.components.length)).toEqual([1]);
  });

  it('offers a next page when there is one, and no previous page on the first', () => {
    const { components } = list({
      events: Array.from({ length: PAGE_SIZE }, (unused, i) => event({ eventId: 10 + i })),
      total: 9,
      offset: 0,
      nextId: 'events:page:5',
      previousId: null,
    });
    const control = components![1]!;
    const buttons = control.components.filter(c => c.kind === 'button');
    expect(buttons.map(c => (c.kind === 'button' ? c.label : ''))).toEqual(['Previous', 'Next']);
    expect(buttons[0]).toMatchObject({ disabled: true });
    expect(buttons[1]).toMatchObject({ disabled: false, customId: 'events:page:5' });
  });

  it('offers a previous page and no next page on the last', () => {
    const { components } = list({
      events: [event()],
      total: 6,
      offset: 5,
      previousId: 'events:page:0',
      nextId: null,
    });
    const buttons = components![1]!.components.filter(c => c.kind === 'button');
    expect(buttons[0]).toMatchObject({ disabled: false, customId: 'events:page:0' });
    expect(buttons[1]).toMatchObject({ disabled: true });
  });

  it('says so in a sentence when nothing is coming up, and offers no buttons', () => {
    const empty = list({ events: [], total: 0 });
    expect(empty.content).toContain('There is nothing coming up');
    expect(empty.components ?? []).toEqual([]);
  });

  it('passes every string in the list through the language check', async () => {
    const strings: string[] = [];
    for (const rendered of [
      list(),
      list({ events: [], total: 0 }),
      list({ events: [event({ isPrivate: true, cancelledAt: '2026-09-08T09:00:00-05:00' })] }),
      list({ events: [event()], total: 9, offset: 5, previousId: 'p', nextId: 'n' }),
    ]) {
      strings.push(rendered.content);
      for (const row of rendered.components ?? []) {
        for (const component of row.components) {
          if (component.kind === 'button') strings.push(component.label);
        }
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'via-bot-list-'));
    try {
      const path = join(dir, 'strings.txt');
      await writeFile(path, strings.join('\n') + '\n');
      expect(findViolations([path])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
