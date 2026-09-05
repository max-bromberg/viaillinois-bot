import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createViaHttpClient, INTERNAL_PREFIX } from '../../src/via/http.ts';
import { ViaError, ViaBusyError } from '../../src/via/client.ts';

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
