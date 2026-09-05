import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createViaHttpClient, INTERNAL_PREFIX } from '../../src/via/http.ts';
import {
  ViaError, ViaBusyError, outboxChangedFields, outboxEvent,
} from '../../src/via/client.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/internal/${name}`, import.meta.url), 'utf8');

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * A fetch that answers from a queue of canned answers and records what it was
 * asked, so a test can assert on the headers the bot sends without a web
 * platform anywhere near it.
 */
function recordingFetch(answers: Array<() => Response | Promise<Response>>) {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = answers.shift();
    if (!next) throw new Error(`the fake fetch ran out of answers after ${calls.length} calls`);
    return next();
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

// A 204 carries no body at all, which Response itself insists on.
const json = (status: number, body: string, headers: Record<string, string> = {}) =>
  () => new Response(body === '' ? null : body, { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A recorded sleep, so a test can see how long the client waited and when. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => { waits.push(ms); },
  };
}

function client(answers: Array<() => Response | Promise<Response>>, overrides: Record<string, unknown> = {}) {
  const fetcher = recordingFetch(answers);
  const clock = recordingSleep();
  const via = createViaHttpClient({
    baseUrl: 'http://via:3001',
    serviceToken: 'service-token',
    fetchImpl: fetcher.fetchImpl,
    sleep: clock.sleep,
    newRequestId: () => 'request-1',
    ...overrides,
  });
  return { via, calls: fetcher.calls, waits: clock.waits };
}

describe('the web platform client over HTTP', () => {
  it('reaches the internal prefix on the address the configuration names', async () => {
    const { via, calls } = client([json(200, fixture('links.session.json'))]);
    await via.openLinkSession('204255221017214977');
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/links/sessions`);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ discord_user_id: '204255221017214977' });
  });

  it('carries the service token on every request', async () => {
    const { via, calls } = client([
      json(200, fixture('links.session.json')),
      json(200, fixture('links.link.json')),
      json(204, ''),
      json(200, fixture('health.json')),
    ]);
    await via.openLinkSession('204255221017214977');
    await via.getLink('204255221017214977');
    await via.unlink('204255221017214977');
    await via.health();
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers.authorization).toBe('Bearer service-token');
    }
  });

  it('carries a request identifier on every request', async () => {
    const { via, calls } = client([json(200, fixture('links.session.json'))]);
    await via.openLinkSession('204255221017214977');
    expect(calls[0]!.headers['x-via-request-id']).toBe('request-1');
  });

  it('sets the acting header only when it is acting for a person', async () => {
    const { via, calls } = client([
      json(200, fixture('links.session.json')),
      json(200, '{"ok":true}'),
    ]);
    await via.openLinkSession('204255221017214977');
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBeUndefined();

    await via.request({ method: 'GET', path: '/events', actingDiscordUserId: '204255221017214977' });
    expect(calls[1]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
  });

  it('never claims a forwarded address, because the internal prefix refuses one', async () => {
    const { via, calls } = client([json(200, fixture('links.session.json'))]);
    await via.openLinkSession('204255221017214977');
    expect(Object.keys(calls[0]!.headers)).not.toContain('x-forwarded-for');
    expect(Object.keys(calls[0]!.headers)).not.toContain('cf-connecting-ip');
  });

  it('reads a link session into the shape the commands use', async () => {
    const { via } = client([json(200, fixture('links.session.json'))]);
    const session = await via.openLinkSession('204255221017214977');
    expect(session.address).toBe('https://viaillinois.com/link/discord/hLbQ2mXk9wR4tYu7iOp1aSdFgHjKlZxCvBnM3qWe5rT');
    expect(session.expiresAt).toBe('2026-09-04T18:40:00-05:00');
  });

  it('reads a resolved link, including the display name the confirmation names', async () => {
    const { via, calls } = client([json(200, fixture('links.link.json'))]);
    const link = await via.getLink('204255221017214977');
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/links/204255221017214977`);
    expect(link).not.toBe(null);
    expect(link!.netId).toBe('rgarcia7');
    expect(link!.displayName).toBe('Rosa Garcia');
    expect(link!.isGlobalAdmin).toBe(false);
    expect(link!.memberships).toEqual([
      { rsoId: 4, rsoName: 'IEEE Student Branch', role: 'board' },
      { rsoId: 9, rsoName: 'HKN', role: 'member' },
    ]);
  });

  it('answers with no link rather than an error when there is none', async () => {
    const { via } = client([json(404, fixture('links.unlinked.json'))]);
    expect(await via.getLink('204255221017214977')).toBe(null);
  });

  it('says whether unlinking removed a link', async () => {
    const { via, calls } = client([json(204, ''), json(404, fixture('links.unlinked.json'))]);
    expect(await via.unlink('204255221017214977')).toBe(true);
    expect(calls[0]!.method).toBe('DELETE');
    expect(await via.unlink('204255221017214977')).toBe(false);
  });

  it('turns the not linked code into a typed error carrying the code', async () => {
    const { via } = client([json(403, fixture('error.not_linked.json'))]);
    const failure = await via
      .request({ method: 'GET', path: '/events', actingDiscordUserId: '204255221017214977' })
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('not_linked');
    expect((failure as ViaError).status).toBe(403);
    expect((failure as ViaError).message).toBe('This Discord account is not linked to a VIA account.');
  });

  it('turns any other refusal into a typed error carrying its code', async () => {
    const { via } = client([json(401, '{"error":"A service token is required.","code":"unauthorized"}')]);
    const failure = await via.request({ method: 'GET', path: '/events' }).then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('unauthorized');
    expect((failure as ViaError).status).toBe(401);
  });

  it('waits the number of seconds a busy answer names and then retries once', async () => {
    const { via, calls, waits } = client([
      json(503, fixture('error.busy.json'), { 'Retry-After': '3' }),
      json(200, fixture('links.session.json')),
    ]);
    const session = await via.openLinkSession('204255221017214977');
    expect(waits).toEqual([3000]);
    expect(calls).toHaveLength(2);
    expect(session.address).toContain('https://viaillinois.com/link/discord/');
  });

  it('does not retry before the wait the busy answer named', async () => {
    // The recorded order is the assertion: nothing is sent between the busy
    // answer and the sleep, so the retry cannot have gone out early.
    const order: string[] = [];
    const fetcher = recordingFetch([
      () => { order.push('request'); return new Response(fixture('error.busy.json'), { status: 503 }); },
      () => { order.push('request'); return new Response(fixture('links.session.json'), { status: 200 }); },
    ]);
    const via = createViaHttpClient({
      baseUrl: 'http://via:3001',
      serviceToken: 'service-token',
      fetchImpl: fetcher.fetchImpl,
      sleep: async (ms: number) => { order.push(`sleep ${ms}`); },
      newRequestId: () => 'request-1',
    });
    await via.openLinkSession('204255221017214977');
    expect(order).toEqual(['request', 'sleep 3000', 'request']);
  });

  it('gives up with a busy error carrying the wait when the retry is busy too', async () => {
    const { via, waits } = client([
      json(503, fixture('error.busy.json')),
      json(503, fixture('error.busy.json')),
    ]);
    const failure = await via.openLinkSession('204255221017214977').then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaBusyError);
    expect((failure as ViaBusyError).retryAfterSeconds).toBe(3);
    expect((failure as ViaBusyError).code).toBe('busy');
    expect(waits).toEqual([3000]);
  });

  it('turns a network failure into a typed error rather than a fetch error', async () => {
    const { via } = client([() => { throw new TypeError('fetch failed'); }]);
    const failure = await via.openLinkSession('204255221017214977').then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('unreachable');
    expect((failure as ViaError).status).toBe(0);
    expect((failure as ViaError).message).toBe('The VIA web platform did not answer.');
  });

  it('reports the web platform as healthy only when its health endpoint says so', async () => {
    const { via, calls } = client([json(200, fixture('health.json')), json(503, '{"status":"unavailable"}')]);
    expect(await via.health()).toBe(true);
    expect(calls[0]!.url).toBe('http://via:3001/health');
    expect(await via.health()).toBe(false);
  });

  it('reports the web platform as unhealthy rather than throwing when it cannot be reached', async () => {
    const { via } = client([() => { throw new TypeError('fetch failed'); }]);
    expect(await via.health()).toBe(false);
  });
});

/**
 * The reading endpoints and the binding confirmation.
 *
 * What matters on this side of the client is the request: the path, the query
 * string the web platform's reading router actually parses, and the acting
 * header, which is what decides whether an internal event is shown at all.
 * The shapes that come back are the recorded fixtures, read through the same
 * parsers the fake uses.
 */
describe('reading through the web platform client', () => {
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

  it('lists every organization', async () => {
    const { via, calls } = client([json(200, fixture('rsos.json'))]);
    const rsos = await via.listRsos();
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/rsos`);
    expect(rsos).toEqual([{
      rsoId: 1,
      name: 'IEEE',
      description: 'The student branch at Illinois.',
      logoColor: '#13294B',
    }]);
  });

  it('reads one organization with the events it has coming up', async () => {
    const { via, calls } = client([json(200, fixture('rso.json'))]);
    const answer = await via.getRso(1);
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/rsos/1`);
    expect(answer!.rso.name).toBe('IEEE');
    expect(answer!.events).toHaveLength(1);
    expect(answer!.events[0]!.title).toBe('General meeting');
  });

  it('answers with nothing for an organization the web platform does not have', async () => {
    const { via } = client([json(404, fixture('refusal.json'))]);
    expect(await via.getRso(999)).toBe(null);
  });

  it('names the filters the reading router parses, and no others', async () => {
    const { via, calls } = client([json(200, fixture('events.json'))]);
    await via.listEvents({
      rsoIds: [1, 4],
      from: '2026-09-10',
      to: '2026-09-17',
      includeInternal: true,
      limit: 5,
      offset: 10,
      actingDiscordUserId: '204255221017214977',
    });
    expect(query(calls[0]!.url)).toEqual({
      rso_ids: '1,4',
      from: '2026-09-10',
      to: '2026-09-17',
      timeframe: 'upcoming',
      include_internal: 'true',
      limit: '5',
      offset: '10',
    });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
  });

  it('asks for nothing it was not given, so the router applies its own defaults', async () => {
    const { via, calls } = client([json(200, fixture('events.json'))]);
    await via.listEvents({});
    expect(query(calls[0]!.url)).toEqual({ timeframe: 'upcoming' });
  });

  it('never asks for internal events unless it was told to', async () => {
    const { via, calls } = client([json(200, fixture('events.json'))]);
    await via.listEvents({ rsoIds: [1], actingDiscordUserId: '204255221017214977' });
    expect(query(calls[0]!.url).include_internal).toBeUndefined();
  });

  it('reads the events and the total the router answers with', async () => {
    const { via } = client([json(200, fixture('events.json'))]);
    const answer = await via.listEvents({});
    expect(answer.total).toBe(1);
    expect(answer.events[0]).toMatchObject({
      eventId: 10,
      rsoId: 1,
      rsoName: 'IEEE',
      title: 'General meeting',
      startTime: '2026-09-10T18:00:00-05:00',
      isPrivate: false,
      cancelledAt: null,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
      locationNote: 'Use the north entrance.',
      seriesId: 4,
      interestCount: 3,
    });
  });

  it('reads one event as the person who asked for it', async () => {
    const { via, calls } = client([json(200, fixture('event.json'))]);
    const event = await via.getEvent(10, '204255221017214977');
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10`);
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
    expect(event!.title).toBe('General meeting');
  });

  it('answers with nothing for an event the person may not see', async () => {
    const { via } = client([json(404, fixture('refusal.json'))]);
    expect(await via.getEvent(10)).toBe(null);
  });

  it('reads the calendar file as the text it is, rather than as JSON', async () => {
    const recorded = JSON.parse(fixture('eventCalendar.json')) as { content_type: string; body: string };
    const { via, calls } = client([
      () => new Response(recorded.body, { status: 200, headers: { 'Content-Type': recorded.content_type } }),
    ]);
    const calendar = await via.getEventCalendar(10);
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10/calendar`);
    expect(calendar).toBe(recorded.body);
  });
});

describe('confirming that a server may be bound to an organization', () => {
  it('asks the web platform as the person who is binding', async () => {
    const { via, calls } = client([json(200, fixture('guilds.bindingConfirmed.json'))]);
    await via.confirmBinding(4, '204255221017214977');
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/guilds/bindings/confirm`);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ rso_id: 4 });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
  });

  it('turns a refusal into the typed error its code names', async () => {
    const { via } = client([json(403, fixture('error.forbidden.json'))]);
    const failure = await via.confirmBinding(4, '204255221017214977').then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('forbidden');
  });

  it('turns a missing link into the not linked error rather than a plain refusal', async () => {
    const { via } = client([json(403, fixture('error.not_linked.json'))]);
    const failure = await via.confirmBinding(4, '204255221017214977').then(() => null, (err: unknown) => err);
    expect((failure as ViaError).code).toBe('not_linked');
  });
});

describe('reading the outbox', () => {
  it('asks for the entries after the cursor it holds, in the order they were written', async () => {
    const { via, calls } = client([json(200, fixture('outbox.json'))]);
    const page = await via.readOutbox({ after: 0, limit: 50 });
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/outbox?after=0&limit=50`);
    expect(calls[0]!.method).toBe('GET');
    expect(page.entries.map(entry => entry.outboxId)).toEqual([1, 2]);
    expect(page.nextAfter).toBe(2);
  });

  it('carries the service token and no acting person, because the outbox is nobody in particular', async () => {
    const { via, calls } = client([json(200, fixture('outbox.json'))]);
    await via.readOutbox({ after: 7 });
    expect(calls[0]!.headers.authorization).toBe('Bearer service-token');
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBeUndefined();
  });

  it('reads the kind, the subject and the organization an entry names', async () => {
    const { via } = client([json(200, fixture('outbox.json'))]);
    const [first] = (await via.readOutbox({ after: 0 })).entries;
    expect(first!.kind).toBe('event.created');
    expect(first!.subjectType).toBe('event');
    expect(first!.subjectId).toBe('10');
    expect(first!.rsoId).toBe(1);
    expect(first!.createdAt).toBe('2026-09-05T12:00:00-05:00');
  });

  it('reads the event an entry carries through the same parser the reading endpoints use', async () => {
    const { via } = client([json(200, fixture('outbox.json'))]);
    const [first] = (await via.readOutbox({ after: 0 })).entries;
    const event = outboxEvent(first!);
    expect(event!.eventId).toBe(10);
    expect(event!.title).toBe('General meeting');
    expect(event!.rsoName).toBe('IEEE');
    expect(event!.startTime).toBe('2026-09-10T18:00:00-05:00');
    expect(event!.seriesId).toBe(4);
  });

  it('reads the fields an update says changed', async () => {
    const { via } = client([json(200, fixture('outbox.json'))]);
    const [, second] = (await via.readOutbox({ after: 0 })).entries;
    expect(outboxChangedFields(second!)).toEqual(['start_time', 'end_time']);
  });

  it('answers with no entries and no cursor when the outbox has nothing new', async () => {
    const { via } = client([json(200, JSON.stringify({ entries: [], next_after: null }))]);
    const page = await via.readOutbox({ after: 11 });
    expect(page.entries).toEqual([]);
    expect(page.nextAfter).toBe(null);
  });
});

describe('recording interest in an event', () => {
  it('sends the acting person for somebody who is linked, and no Discord identifier', async () => {
    const { via, calls } = client([json(200, fixture('interest.json'))]);
    const answer = await via.setInterest(10, { interested: true, actingDiscordUserId: '204255221017214977' });
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10/interest`);
    expect(calls[0]!.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ interested: true });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
    expect(answer.ok).toBe(true);
    expect(answer.interestCount).toBeGreaterThan(0);
  });

  /**
   * Section 10 of the design: interest from somebody who is not linked is
   * counted as a salted hash of their Discord identifier, and the salting is
   * the web platform's. The bot sends the identifier and holds nothing.
   */
  it('sends the Discord identifier for somebody who is not linked, and acts as nobody', async () => {
    const { via, calls } = client([json(200, fixture('interest.json'))]);
    await via.setInterest(10, { interested: true, discordUserId: '301422551071492041' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ interested: true, discord_user_id: '301422551071492041' });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBeUndefined();
  });

  it('clears interest with the same call, said the other way round', async () => {
    const { via, calls } = client([json(200, fixture('interest.json'))]);
    await via.setInterest(10, { interested: false, actingDiscordUserId: '204255221017214977' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ interested: false });
  });

  it('turns a refusal into the typed error its code names', async () => {
    const { via } = client([json(404, fixture('refusal.json'))]);
    const failure = await via.setInterest(10, { interested: true, discordUserId: '1' })
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
  });
});

/**
 * The personal calendar, from section 6 of the companion specification. The
 * address carries a token the web platform stores hashed, so asking for the
 * calendar again rotates the token, and the organizations it carries are
 * updated on their own whenever the person's follows change.
 */
describe('the personal calendar', () => {
  const ADA = '204255221017214977';

  it('creates or rotates the calendar for the acting person, with the organizations they follow', async () => {
    const { via, calls } = client([json(200, fixture('calendars.personal.json'))]);
    const calendar = await via.createPersonalCalendar([3, 7], ADA);

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/calendars/personal`);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ rso_ids: [3, 7] });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe(ADA);
    expect(calendar.address).toContain('/calendar/personal/');
    expect(calendar.rotatedAt).toBe(JSON.parse(fixture('calendars.personal.json')).rotated_at);
  });

  it('says that a person follows every organization by sending no set at all', async () => {
    const { via, calls } = client([json(200, fixture('calendars.personal.json'))]);
    await via.createPersonalCalendar(null, ADA);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ rso_ids: null });
  });

  it('updates the organizations a calendar carries without rotating its token', async () => {
    const { via, calls } = client([json(200, fixture('calendars.personalRsos.json'))]);
    await via.updatePersonalCalendarRsos([3], ADA);

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/calendars/personal/rsos`);
    expect(calls[0]!.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ rso_ids: [3] });
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe(ADA);
  });

  it('turns a refusal into the typed error its code names', async () => {
    const { via } = client([json(403, fixture('error.not_linked.json'))]);
    const failure = await via.createPersonalCalendar(null, ADA)
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('not_linked');
  });
});

/**
 * The campus lookups, from section 6.5 of the design: the midterm schedule,
 * the course catalogue, the rooms of a building and the building codes. All
 * four are reads with no acting person, because none of them depends on who
 * is asking.
 */
describe('the campus lookups', () => {
  it('asks for the midterms of one course, in a window', async () => {
    const { via, calls } = client([json(200, fixture('midterms.json'))]);
    const midterms = await via.listMidterms({ course: 'ECE 385', from: '2026-09-06', to: '2026-09-12' });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`${INTERNAL_PREFIX}/midterms`);
    expect(url.searchParams.get('course')).toBe('ECE 385');
    expect(url.searchParams.get('from')).toBe('2026-09-06');
    expect(url.searchParams.get('to')).toBe('2026-09-12');

    expect(midterms).toHaveLength(1);
    expect(midterms[0]!.courseCode).toBe('ECE 385');
    expect(midterms[0]!.courseTitle).toBe('Digital Systems Laboratory');
    expect(midterms[0]!.status).toBe('confirmed');
    expect(midterms[0]!.building).toBe('Everitt Laboratory');
    expect(midterms[0]!.roomNumber).toBe('151');
  });

  it('sends no filter the caller did not name', async () => {
    const { via, calls } = client([json(200, fixture('midterms.json'))]);
    await via.listMidterms({});
    expect(new URL(calls[0]!.url).search).toBe('');
  });

  it('searches the course catalogue, and asks for the sections when they are wanted', async () => {
    const { via, calls } = client([json(200, fixture('courses.json'))]);
    const courses = await via.searchCourses('ECE 3', { sections: true });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`${INTERNAL_PREFIX}/courses`);
    expect(url.searchParams.get('query')).toBe('ECE 3');
    expect(url.searchParams.get('sections')).toBe('true');

    expect(courses[0]!.courseCode).toBe('ECE 385');
    expect(courses[0]!.sections[0]).toMatchObject({
      sectionId: 1,
      dayOfWeek: 'MW',
      startTime: '10:00:00',
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
    });
  });

  it('leaves the sections out when only the names were wanted', async () => {
    const { via, calls } = client([json(200, fixture('courses.json'))]);
    await via.searchCourses('ECE 3');
    expect(new URL(calls[0]!.url).searchParams.get('sections')).toBe(null);
  });

  it('searches the rooms VIA knows', async () => {
    const { via, calls } = client([json(200, fixture('locations.json'))]);
    const locations = await via.searchLocations('ECEB');

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`${INTERNAL_PREFIX}/locations`);
    expect(url.searchParams.get('query')).toBe('ECEB');
    expect(locations[0]).toMatchObject({
      locationId: 5,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
      maxCapacity: 40,
      hasAvEquipment: true,
    });
  });

  it('asks which rooms of a building are free in a window', async () => {
    const { via, calls } = client([json(200, fixture('locationsFree.json'))]);
    const free = await via.freeRooms({
      building: 'ECEB',
      from: '2026-09-10 18:00:00',
      to: '2026-09-10 19:00:00',
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`${INTERNAL_PREFIX}/locations/free`);
    expect(url.searchParams.get('building')).toBe('ECEB');
    expect(url.searchParams.get('from')).toBe('2026-09-10 18:00:00');
    expect(url.searchParams.get('to')).toBe('2026-09-10 19:00:00');

    expect(free.building).toBe('Electrical & Computer Eng Bldg');
    expect(free.locations).toHaveLength(1);
    expect(free.locations[0]!.roomNumber).toBe('1002');
  });

  it('turns a window the web platform refuses into the typed error, with its sentence', async () => {
    const { via } = client([json(400, JSON.stringify({
      error: 'A window can cover at most 7 days.',
      code: 'invalid',
    }))]);
    const failure = await via.freeRooms({ building: 'ECEB', from: '2026-09-01', to: '2026-09-30' })
      .then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('invalid');
    expect((failure as ViaError).message).toBe('A window can cover at most 7 days.');
  });

  /**
   * The acting endpoints, which are the ones a board member reaches through
   * the bot. Every one of them carries the acting header and nothing else that
   * says who is asking, because the web platform resolves the Discord account
   * to a NetID through its own link table and decides from there.
   */
  it('postpones an event as the acting person, sending the two times and the reason', async () => {
    const { via, calls } = client([json(200, fixture('acting.postpone.json'))]);
    const event = await via.postponeEvent(10, {
      startTime: '2026-09-17 18:00:00',
      endTime: '2026-09-17 19:00:00',
      reason: 'The room flooded.',
    }, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10/postpone`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      start_time: '2026-09-17 18:00:00',
      end_time: '2026-09-17 19:00:00',
      reason: 'The room flooded.',
    });
    expect(event!.eventId).toBe(10);
    expect(event!.startTime).toBe('2026-09-10T18:00:00-05:00');
  });

  it('sends no reason when the board gave none', async () => {
    const { via, calls } = client([json(200, fixture('acting.postpone.json'))]);
    await via.postponeEvent(10, {
      startTime: '2026-09-17 18:00:00',
      endTime: '2026-09-17 19:00:00',
    }, '204255221017214977');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      start_time: '2026-09-17 18:00:00',
      end_time: '2026-09-17 19:00:00',
    });
  });

  it('cancels an event and answers with the moment it was cancelled at', async () => {
    const { via, calls } = client([json(200, fixture('acting.cancel.json'))]);
    const cancelledAt = await via.cancelEvent(10, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10/cancel`);
    expect(calls[0]!.method).toBe('POST');
    expect(cancelledAt).toBe('2026-09-05T12:00:00-05:00');
  });

  it('changes only the fields the caller named on an event', async () => {
    const { via, calls } = client([json(200, fixture('acting.patch.json'))]);
    const event = await via.patchEvent(10, { locationNote: 'Use the north entrance.' }, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/10`);
    expect(calls[0]!.method).toBe('PATCH');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ location_note: 'Use the north entrance.' });
    expect(event!.locationNote).toBe('Use the north entrance.');
  });

  it('clears a note and a description with null rather than leaving them out', async () => {
    const { via, calls } = client([json(200, fixture('acting.patch.json'))]);
    await via.patchEvent(10, { description: null, locationNote: null }, '204255221017214977');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ description: null, location_note: null });
  });

  it('switches an event between public and internal', async () => {
    const { via, calls } = client([json(200, fixture('acting.patch.json'))]);
    await via.patchEvent(10, { isPrivate: true }, '204255221017214977');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ is_private: true });
  });

  it('asks the scheduler the same question the dashboard asks, and reads its answer', async () => {
    const { via, calls } = client([json(200, fixture('scheduler.recommend.json'))]);
    const answer = await via.recommendSchedule({
      rsoId: 1,
      durationMinutes: 60,
      dateRange: { start: '2026-09-14', end: '2026-09-21' },
      timeConstraint: { startHour: 18, endHour: 22 },
      recurrence: { intervalWeeks: 1, daysOfWeek: [], until: '2026-12-09' },
    }, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/scheduler/recommend`);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      rso_id: 1,
      durationMinutes: 60,
      dateRange: { start: '2026-09-14', end: '2026-09-21' },
      timeConstraint: { startHour: 18, endHour: 22, tier: 'required' },
      recurrence: { intervalWeeks: 1, daysOfWeek: [], until: '2026-12-09' },
    });

    expect(answer.curatedPicks).toHaveLength(2);
    expect(answer.curatedPicks[0]).toMatchObject({
      startTime: '2026-09-16 18:00:00',
      endTime: '2026-09-16 19:00:00',
      score: 91,
      locationId: 5,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
      weeksTotal: 13,
      weeksClear: 12,
    });
    expect(answer.curatedPicks[0]!.reasons).toContain('This room is free for 12 of 13 weeks');
    expect(answer.curatedPicks[0]!.daysOfWeek).toEqual(['Wed']);
    expect(answer.curatedPicks[0]!.until).toBe('2026-12-09');
    expect(answer.allOptions).toHaveLength(2);
  });

  it('creates a repeat as the dashboard form does, and answers with what it created', async () => {
    const { via, calls } = client([json(201, fixture('acting.series.json'))]);
    const created = await via.createEventSeries({
      rsoId: 1,
      title: 'Weekly meeting',
      startTime: '2026-09-14 18:00:00',
      endTime: '2026-09-14 19:00:00',
      locationId: 5,
      recurrence: { intervalWeeks: 1, daysOfWeek: ['MO'], endsOn: '2026-09-28' },
    }, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/events/series`);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      rso_id: 1,
      title: 'Weekly meeting',
      start_time: '2026-09-14 18:00:00',
      end_time: '2026-09-14 19:00:00',
      location_id: 5,
      recurrence: { interval_weeks: 1, days_of_week: ['MO'], ends_on: '2026-09-28' },
    });
    expect(created).toEqual({ seriesId: 4, eventIds: [10, 11, 12], created: 3, skipped: [] });
  });

  it('reads the members of an organization as the acting person, with their roles lowered', async () => {
    const { via, calls } = client([json(200, fixture('rsoMembers.json'))]);
    const members = await via.listRsoMembers(1, '204255221017214977');

    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/rsos/1/members`);
    expect(calls[0]!.headers['x-via-acting-discord-user']).toBe('204255221017214977');
    expect(members).toEqual([{ netId: 'alice', fullName: 'Alice Adams', role: 'board' }]);
  });

  it('turns a refusal of an acting call into the typed error, with the sentence the web platform wrote', async () => {
    const { via } = client([json(403, fixture('error.forbidden.json'))]);
    const failure = await via.cancelEvent(10, '204255221017214977')
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ViaError);
    expect((failure as ViaError).code).toBe('forbidden');
  });

  it('looks a building code up, and answers with nothing for a code VIA does not know', async () => {
    const { via, calls } = client([
      json(200, fixture('building.json')),
      json(404, fixture('refusal.json')),
    ]);

    const building = await via.getBuilding('eceb');
    expect(calls[0]!.url).toBe(`http://via:3001${INTERNAL_PREFIX}/buildings/eceb`);
    expect(building).toEqual({
      code: 'ECEB',
      name: 'Electrical & Computer Eng Bldg',
      address: null,
    });

    expect(await via.getBuilding('nowhere')).toBe(null);
  });
});
