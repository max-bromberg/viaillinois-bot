import { describe, it, expect } from 'vitest';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { withHotReadCache, HOT_READ_TTL_MS, MAX_CACHE_ENTRIES } from '../../src/via/cache.ts';

/**
 * The hot read cache.
 *
 * The design names two reads as hot: the organization list, which every
 * autocomplete needs, and the events coming up for an organization, which
 * every listing needs. Both are cached for a minute, so a room full of
 * students typing into the same autocomplete is one call to the web platform
 * rather than a hundred.
 *
 * The clock is injected, so these tests move time rather than wait for it.
 */
describe('caching the hot reads', () => {
  function cached(startAt = '2026-09-05T14:30:00Z') {
    const via = createFakeViaClient();
    let clock = new Date(startAt);
    const client = withHotReadCache(via, { now: () => clock });
    return {
      via,
      client,
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    };
  }

  it('caches the organization list for a minute', () => {
    expect(HOT_READ_TTL_MS).toBe(60_000);
  });

  it('asks the web platform once for a list two callers wanted at the same moment', async () => {
    const { via, client } = cached();
    const first = await client.listRsos();
    const second = await client.listRsos();
    expect(second).toEqual(first);
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(1);
  });

  it('asks again once the minute is over', async () => {
    const { via, client, advance } = cached();
    await client.listRsos();
    advance(HOT_READ_TTL_MS - 1);
    await client.listRsos();
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(1);

    advance(2);
    await client.listRsos();
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(2);
  });

  it('hands each caller its own copy, so one caller cannot change another answer', async () => {
    const { client } = cached();
    const first = await client.listRsos();
    first[0]!.name = 'changed by the caller';
    expect((await client.listRsos())[0]!.name).toBe('IEEE');
  });

  it('caches the events coming up for an organization', async () => {
    const { via, client } = cached();
    await client.listEvents({ rsoIds: [1] });
    await client.listEvents({ rsoIds: [1] });
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(1);
  });

  it('tells one listing from another rather than answering both from one entry', async () => {
    const { via, client } = cached();
    await client.listEvents({ rsoIds: [1] });
    await client.listEvents({ rsoIds: [9] });
    await client.listEvents({ rsoIds: [1], from: '2026-09-10' });
    await client.listEvents({ rsoIds: [1], limit: 5, offset: 5 });
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(4);
  });

  it('asks the web platform again for a listing once the minute is over', async () => {
    const { via, client, advance } = cached();
    await client.listEvents({ rsoIds: [1] });
    advance(HOT_READ_TTL_MS + 1);
    await client.listEvents({ rsoIds: [1] });
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(2);
  });

  /**
   * An internal listing is answered differently for every person who asks,
   * because the web platform decides from their memberships. Caching one
   * person's answer and serving it to the next would show one student another
   * organization's internal events, so a listing that asks for them is never
   * cached at all.
   */
  it('never caches a listing that asked for internal events', async () => {
    const { via, client } = cached();
    const query = { rsoIds: [1], includeInternal: true, actingDiscordUserId: '204255221017214977' };
    await client.listEvents(query);
    await client.listEvents(query);
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(2);
  });

  it('serves one cached listing to two different people, since neither asked for internal events', async () => {
    const { via, client } = cached();
    await client.listEvents({ rsoIds: [1], actingDiscordUserId: '204255221017214977' });
    await client.listEvents({ rsoIds: [1], actingDiscordUserId: '301422551071492041' });
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(1);
  });

  it('drops what it holds for an organization the outbox says has changed', async () => {
    const { via, client } = cached();
    await client.listRsos();
    await client.listEvents({ rsoIds: [1] });
    await client.listEvents({ rsoIds: [9] });

    client.invalidateRso(1);

    await client.listRsos();
    await client.listEvents({ rsoIds: [1] });
    await client.listEvents({ rsoIds: [9] });
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(2);
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(3);
  });

  it('drops a listing across every organization when any of them changes', async () => {
    const { via, client } = cached();
    await client.listEvents({});
    client.invalidateRso(1);
    await client.listEvents({});
    expect(via.calls.filter(call => call === 'listEvents')).toHaveLength(2);
  });

  it('passes everything else straight through, uncached', async () => {
    const { via, client } = cached();
    await client.getEvent(10);
    await client.getEvent(10);
    await client.getRso(1);
    await client.getRso(1);
    expect(via.calls.filter(call => call === 'getEvent')).toHaveLength(2);
    expect(via.calls.filter(call => call === 'getRso')).toHaveLength(2);
  });

  it('caches nothing a failed call would have held', async () => {
    const { via, client } = cached();
    via.failNextWith(new Error('the web platform fell over'));
    await client.listRsos().then(() => null, () => null);
    await client.listRsos();
    expect(via.calls.filter(call => call === 'listRsos')).toHaveLength(1);
  });
});

/**
 * The two campus reads that are hot for the same reason the organization list
 * is: a course autocomplete fires on every keystroke, and a room full of
 * students asking when the next exam is asks the same question. Both are the
 * same answer for everybody, which is what makes holding them safe.
 */
describe('caching the campus reads', () => {
  function cached(startAt = '2026-09-05T14:30:00Z') {
    const via = createFakeViaClient();
    let clock = new Date(startAt);
    const client = withHotReadCache(via, { now: () => clock });
    return {
      via,
      client,
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    };
  }

  it('asks the web platform once for a course search two keystrokes apart wanted', async () => {
    const { via, client } = cached();
    const first = await client.searchCourses('ECE 3');
    const second = await client.searchCourses('ECE 3');
    expect(second).toEqual(first);
    expect(via.calls.filter(call => call === 'searchCourses')).toHaveLength(1);
  });

  it('tells one course search from another, and a search with sections from one without', async () => {
    const { via, client } = cached();
    await client.searchCourses('ECE 3');
    await client.searchCourses('ECE 4');
    await client.searchCourses('ECE 3', { sections: true });
    expect(via.calls.filter(call => call === 'searchCourses')).toHaveLength(3);
  });

  it('asks again for a course search once the minute is over', async () => {
    const { via, client, advance } = cached();
    await client.searchCourses('ECE 3');
    advance(HOT_READ_TTL_MS + 1);
    await client.searchCourses('ECE 3');
    expect(via.calls.filter(call => call === 'searchCourses')).toHaveLength(2);
  });

  it('holds a midterm listing for a minute, and tells one window from another', async () => {
    const { via, client, advance } = cached();
    await client.listMidterms({ course: 'ECE 385' });
    await client.listMidterms({ course: 'ECE 385' });
    expect(via.calls.filter(call => call === 'listMidterms')).toHaveLength(1);

    await client.listMidterms({ course: 'ECE 385', from: '2026-10-01' });
    expect(via.calls.filter(call => call === 'listMidterms')).toHaveLength(2);

    advance(HOT_READ_TTL_MS + 1);
    await client.listMidterms({ course: 'ECE 385' });
    expect(via.calls.filter(call => call === 'listMidterms')).toHaveLength(3);
  });

  it('gives each caller its own copy, so that one of them cannot change another answer', async () => {
    const { client } = cached();
    const first = await client.listMidterms({});
    first[0]!.title = 'Something else';
    const second = await client.listMidterms({});
    expect(second[0]!.title).not.toBe('Something else');
  });

  it('holds a room search for a minute, because it completes an option too', async () => {
    const { via, client, advance } = cached();
    await client.searchLocations('ECEB');
    await client.searchLocations('ECEB');
    expect(via.calls.filter(call => call === 'searchLocations')).toHaveLength(1);

    await client.searchLocations('Everitt');
    expect(via.calls.filter(call => call === 'searchLocations')).toHaveLength(2);

    advance(HOT_READ_TTL_MS + 1);
    await client.searchLocations('ECEB');
    expect(via.calls.filter(call => call === 'searchLocations')).toHaveLength(3);
  });

  it('passes a building code straight through, because nothing completes on it', async () => {
    const { via, client } = cached();
    await client.getBuilding('ECEB');
    await client.getBuilding('ECEB');
    expect(via.calls.filter(call => call === 'getBuilding')).toHaveLength(2);
  });
});

/**
 * What the cache costs.
 *
 * The searches behind an autocomplete are keyed by what somebody typed, and
 * anybody can type anything, so an unbounded map keyed that way is a map that
 * one person can fill until the process runs out of memory. Each of them holds
 * a bounded number of entries, the ones that have expired go first, and the
 * one used longest ago goes after them.
 */
describe('the bound on what the cache holds', () => {
  function cached(startAt = '2026-09-05T14:30:00Z') {
    const via = createFakeViaClient();
    let clock = new Date(startAt);
    const client = withHotReadCache(via, { now: () => clock });
    return {
      via,
      client,
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    };
  }

  const searches = (via: { calls: string[] }) =>
    via.calls.filter(call => call === 'searchCourses').length;

  it('holds at most the entries it names', () => {
    expect(MAX_CACHE_ENTRIES).toBe(500);
  });

  it('forgets the search used longest ago once it is full', async () => {
    const { via, client } = cached();
    for (let index = 0; index < MAX_CACHE_ENTRIES; index += 1) {
      await client.searchCourses(`term ${index}`);
    }
    const asked = searches(via);
    expect(asked).toBe(MAX_CACHE_ENTRIES);

    // The very first search is still held, so it costs nothing.
    await client.searchCourses('term 0');
    expect(searches(via)).toBe(asked);

    // One more search past the bound pushes out the one used longest ago,
    // which by now is the second search rather than the first.
    await client.searchCourses('one more');
    expect(searches(via)).toBe(asked + 1);
    await client.searchCourses('term 0');
    expect(searches(via)).toBe(asked + 1);
    await client.searchCourses('term 1');
    expect(searches(via)).toBe(asked + 2);
  });

  it('sweeps the entries that have expired rather than counting them', async () => {
    const { via, client, advance } = cached();
    for (let index = 0; index < MAX_CACHE_ENTRIES; index += 1) {
      await client.searchCourses(`term ${index}`);
    }
    advance(HOT_READ_TTL_MS + 1);

    // Everything held has expired, so a search after the minute leaves the
    // cache holding one entry rather than the bound.
    await client.searchCourses('after the minute');
    const asked = searches(via);
    await client.searchCourses('after the minute');
    expect(searches(via)).toBe(asked);
  });

  it('bounds the room searches, the listings and the exam listings as well', async () => {
    const { via, client } = cached();
    for (let index = 0; index < MAX_CACHE_ENTRIES + 10; index += 1) {
      await client.searchLocations(`room ${index}`);
      await client.listEvents({ limit: 5, offset: index });
      await client.listMidterms({ course: `ECE ${index}` });
    }

    // Nothing here asserts a size, because the cache holds no reader for one.
    // What it asserts is that the oldest of each kind has gone, which is what
    // a bound means.
    const before = via.calls.length;
    await client.searchLocations('room 0');
    await client.listEvents({ limit: 5, offset: 0 });
    await client.listMidterms({ course: 'ECE 0' });
    expect(via.calls.length).toBe(before + 3);
  });
});
