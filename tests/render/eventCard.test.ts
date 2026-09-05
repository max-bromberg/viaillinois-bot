import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import {
  renderEventCard, renderRsoCard, MAX_DESCRIPTION_LENGTH, eventAddress,
} from '../../src/render/eventCard.ts';
import type { Reply } from '../../src/discord/adapter.ts';
import type { Rso, ViaEvent } from '../../src/via/client.ts';

/**
 * The event card and the organization card.
 *
 * The card is the one place a student reads everything about an event, so
 * these tests are about what it says: the campus clock with Discord's
 * relative timestamp beside it, where the event is with the board's note
 * underneath, the two markers that change what the event means, and the four
 * buttons. Every string on the card goes through the repository's language
 * check as well, because every one of them is read by a person.
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

const card = (overrides: Partial<ViaEvent> = {}) =>
  renderEventCard(event(overrides), { websiteUrl: WEBSITE });

/** Every string a person can read in a reply, for the language check. */
function everyString(reply: Reply): string[] {
  const strings = [reply.content];
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'button') strings.push(component.label);
      if (component.kind === 'select') {
        if (component.placeholder) strings.push(component.placeholder);
        for (const option of component.options ?? []) {
          strings.push(option.label);
          if (option.description) strings.push(option.description);
        }
      }
    }
  }
  return strings;
}

async function expectNoLanguageViolations(strings: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'via-bot-render-'));
  try {
    const path = join(dir, 'strings.txt');
    await writeFile(path, strings.join('\n') + '\n');
    expect(findViolations([path])).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the event card', () => {
  it('names the event and the organization it belongs to', () => {
    const { content } = card();
    expect(content).toContain('General meeting');
    expect(content).toContain('IEEE');
  });

  it('shows the campus clock with the relative timestamp beside it', () => {
    const { content } = card();
    expect(content).toContain('Thu, Sep 10 at 6:00 PM');
    expect(content).toContain('<t:1789081200:R>');
  });

  it('shows when the event ends, on the same day without repeating the date', () => {
    expect(card().content).toContain('Thu, Sep 10 at 6:00 PM to 7:00 PM');
  });

  it('writes both dates out for an event that runs past midnight', () => {
    const { content } = card({ endTime: '2026-09-11T01:00:00-05:00' });
    expect(content).toContain('Thu, Sep 10 at 6:00 PM to Fri, Sep 11 at 1:00 AM');
  });

  it('shows the building and the room', () => {
    expect(card().content).toContain('Electrical & Computer Eng Bldg 1002');
  });

  it('shows a place written by hand when the event is not in a room VIA knows', () => {
    const { content } = card({ locationId: null, building: null, roomNumber: null, locationText: 'The quad' });
    expect(content).toContain('The quad');
  });

  it('says the place is not settled yet rather than showing an empty line', () => {
    const { content } = card({ locationId: null, building: null, roomNumber: null, locationText: null });
    expect(content).toContain('The place has not been announced yet.');
  });

  it('puts the board note beneath the place, on its own line', () => {
    const { content } = card({ locationNote: 'Use the north entrance.' });
    const lines = content.split('\n');
    const place = lines.findIndex(line => line.includes('Electrical & Computer Eng Bldg 1002'));
    expect(lines[place + 1]).toContain('Use the north entrance.');
  });

  it('marks an internal event as one, so nobody shares it by accident', () => {
    expect(card({ isPrivate: true }).content).toContain('internal');
    expect(card().content).not.toContain('internal');
  });

  it('marks a cancelled event as cancelled rather than quietly showing the old time', () => {
    const { content } = card({ cancelledAt: '2026-09-08T09:00:00-05:00' });
    expect(content.toLowerCase()).toContain('cancelled');
    expect(card().content.toLowerCase()).not.toContain('cancelled');
  });

  it('describes the pattern of an event that belongs to a series', () => {
    const { content } = card({
      seriesId: 4,
      seriesFrequency: 'weekly',
      seriesIntervalWeeks: 1,
      seriesDaysOfWeek: 'MO,WE',
      seriesEndsOn: '2026-12-09',
    });
    expect(content).toContain('every week');
    expect(content).toContain('Monday');
    expect(content).toContain('Wednesday');
    expect(content).toContain('Dec 9');
  });

  it('carries the description as the board wrote it', () => {
    expect(card().content).toContain('Bring a laptop.');
  });

  it('trims a description nobody would read to the end of in a card', () => {
    const { content } = card({ description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 500) });
    expect(content.length).toBeLessThan(MAX_DESCRIPTION_LENGTH + 500);
    expect(content).toContain('Read the rest on viaillinois.com.');
  });

  it('leaves the description out entirely when there is none', () => {
    expect(card({ description: null }).content).not.toContain('undefined');
  });

  it('offers the four buttons the design names, in that order', () => {
    const [row] = card().components!;
    expect(row!.components.map(c => (c.kind === 'button' ? c.label : ''))).toEqual([
      'Remind me', 'Interested', 'Add to calendar', 'Open on VIA',
    ]);
  });

  it('opens the event page on the website with the link button', () => {
    const [row] = card().components!;
    const open = row!.components.find(c => c.kind === 'button' && c.style === 'link');
    expect(open).toMatchObject({ url: 'https://viaillinois.com/events/10' });
    expect(eventAddress(10, WEBSITE)).toBe('https://viaillinois.com/events/10');
  });

  it('carries the event on every button the bot answers, so a click knows what it is about', () => {
    const [row] = card().components!;
    for (const component of row!.components) {
      if (component.kind === 'button' && component.customId) {
        expect(component.customId).toContain('10');
      }
    }
  });

  it('offers no reminder for an event that has been cancelled', () => {
    const [row] = card({ cancelledAt: '2026-09-08T09:00:00-05:00' }).components!;
    const remind = row!.components.find(c => c.kind === 'button' && c.label === 'Remind me');
    expect(remind).toMatchObject({ disabled: true });
  });

  it('passes every string on the card through the language check', async () => {
    await expectNoLanguageViolations([
      ...everyString(card()),
      ...everyString(card({ isPrivate: true, cancelledAt: '2026-09-08T09:00:00-05:00' })),
      ...everyString(card({ locationId: null, building: null, roomNumber: null, locationText: null })),
      ...everyString(card({ description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 10) })),
      ...everyString(card({
        seriesId: 4, seriesFrequency: 'weekly', seriesIntervalWeeks: 2,
        seriesDaysOfWeek: 'MO,WE', seriesEndsOn: '2026-12-09',
      })),
    ]);
  });
});

describe('the organization card', () => {
  const rso: Rso = {
    rsoId: 1,
    name: 'IEEE',
    description: 'The student branch at Illinois.',
    logoColor: '#13294B',
  };

  const rsoCard = (events: ViaEvent[] = [event()]) =>
    renderRsoCard({ rso, events }, { websiteUrl: WEBSITE });

  it('names the organization and carries its description', () => {
    const { content } = rsoCard();
    expect(content).toContain('IEEE');
    expect(content).toContain('The student branch at Illinois.');
  });

  it('lists the events it has coming up, on the campus clock', () => {
    const { content } = rsoCard();
    expect(content).toContain('General meeting');
    expect(content).toContain('Thu, Sep 10 at 6:00 PM');
    expect(content).toContain('<t:1789081200:R>');
  });

  it('says so in a sentence when there is nothing coming up', () => {
    expect(rsoCard([]).content).toContain('IEEE has nothing coming up right now.');
  });

  it('offers a follow button and a link to the organization page', () => {
    const [row] = rsoCard().components!;
    const labels = row!.components.map(c => (c.kind === 'button' ? c.label : ''));
    expect(labels).toContain('Follow');
    expect(labels).toContain('Open on VIA');
    const open = row!.components.find(c => c.kind === 'button' && c.style === 'link');
    expect(open).toMatchObject({ url: 'https://viaillinois.com/rsos/1' });
  });

  it('says something sensible for an organization that wrote no description', () => {
    const { content } = renderRsoCard({ rso: { ...rso, description: null }, events: [] }, { websiteUrl: WEBSITE });
    expect(content).not.toContain('null');
  });

  it('passes every string on the card through the language check', async () => {
    await expectNoLanguageViolations([
      ...everyString(rsoCard()),
      ...everyString(rsoCard([])),
    ]);
  });
});
