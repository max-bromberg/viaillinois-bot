import { readFileSync } from 'node:fs';
import {
  ViaError, parseEvent, parseLinkSession, parseLinkedAccount, parseOutboxEntry, parseRsos,
  type ViaClient, type EventPage, type EventQuery, type InterestAnswer, type InterestSignal,
  type LinkSession, type LinkedAccount, type OutboxEntry, type OutboxPage, type OutboxQuery,
  type Rso, type RsoWithEvents, type ViaEvent,
} from './client.ts';

/**
 * The in memory web platform client.
 *
 * Commands are written against the ViaClient interface, so their tests run
 * against this rather than against HTTP. The answers it serves are the
 * recorded shapes under tests/fixtures/internal, read through the same two
 * parsers the HTTP implementation uses, so a fixture that stops matching the
 * web platform breaks the fake as well as the real client.
 *
 * The seeding helpers are what tests reach for: seedLink puts a link in
 * place, and seedLink with afterLookups makes a link that resolves only after
 * a few lookups, which is what the link command polls for. seedRso and
 * seedEvent add to the recorded organization and event the fake starts with,
 * so a test that needs a second page of events writes eight lines rather than
 * a fixture. seedOutbox adds one outbox entry, built from the recorded entry
 * of that kind, so a test about the consumer or an announcement is written
 * against the shape the web platform actually writes.
 *
 * Two rules are modelled here rather than served from a file, because they are
 * rules the web platform applies rather than shapes it sends: an internal
 * event is shown only to a member of that organization who asked for internal
 * events, and a server may be bound to an organization only by a board member
 * of it or a global administrator. Both are the web platform's decisions in
 * production, and the fake exists so that a command's handling of both
 * answers can be tested.
 *
 * This module reads the fixtures from the test tree, which the container
 * image does not carry, and nothing under src imports it. Were something ever
 * to import it in a deployed bot, it would fail at startup rather than serve
 * invented answers to real people, which is the failure worth having.
 */

const FIXTURES = new URL('../../tests/fixtures/internal/', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/** The recorded session, whose address and expiry shape every answer follows. */
const SESSION_TEMPLATE = parseLinkSession(fixture('links.session.json'));
/** The recorded link, whose fields fill in whatever a test does not name. */
const LINK_TEMPLATE = parseLinkedAccount(fixture('links.link.json'));
/** The recorded organization, which is what the fake lists until a test seeds more. */
const RECORDED_RSOS = parseRsos(fixture('rsos.json'));
/** The recorded event, which is what the fake lists until a test seeds more. */
const RECORDED_EVENT = parseEvent((fixture('event.json') as { event: unknown }).event);
/** The recorded calendar file, whose text every calendar answer is built from. */
const RECORDED_CALENDAR = (fixture('eventCalendar.json') as { body: string }).body;

/**
 * One recorded entry per outbox kind, as the web platform writes them. A test
 * that seeds an entry seeds the recorded one for that kind and changes what it
 * cares about, so an invented payload shape cannot creep into a test.
 */
const RECORDED_OUTBOX = new Map<string, OutboxEntry>(
  ((fixture('outboxEntries.json') as { entries: unknown[] }).entries)
    .map(raw => parseOutboxEntry(raw))
    .map(entry => [entry.kind, entry]),
);

export interface OpenedSession {
  discordUserId: string;
  session: LinkSession;
}

export interface SeedTiming {
  /** The link answers with nothing for this many lookups before it resolves. */
  afterLookups?: number;
}

/** One interest signal the fake was given, as it was given. */
export interface RecordedInterest {
  eventId: number;
  interested: boolean;
  actingDiscordUserId?: string;
  discordUserId?: string;
}

export interface FakeViaClient extends ViaClient {
  /** Every session the fake was asked to open, in order. */
  readonly sessions: OpenedSession[];
  /** The name of every reading call the fake answered, in order. */
  readonly calls: string[];
  /** Every interest signal the fake was given, in order. */
  readonly interests: RecordedInterest[];
  /**
   * Add one outbox entry, built from the recorded entry of that kind, with
   * the next identifier. Anything the test names replaces what the recording
   * carries.
   */
  seedOutbox(kind: string, overrides?: Partial<OutboxEntry>): OutboxEntry;
  /** Forget every outbox entry, for a test about a bot that is up to date. */
  clearOutbox(): void;
  /** Add or replace an organization, filling anything unnamed from the recorded one. */
  seedRso(overrides?: Partial<Rso>): Rso;
  /** Add or replace an event, filling anything unnamed from the recorded one. */
  seedEvent(overrides?: Partial<ViaEvent>): ViaEvent;
  /** Forget every organization, for a test about an empty campus. */
  clearRsos(): void;
  /** Forget every event, for a test about an empty week. */
  clearEvents(): void;
  /** Put a link in place, filling anything unnamed from the recorded answer. */
  seedLink(discordUserId: string, overrides?: Partial<LinkedAccount>, timing?: SeedTiming): LinkedAccount;
  /** Remove a link without going through the unlink call. */
  removeLink(discordUserId: string): void;
  /** Whether the web platform answers its health endpoint. */
  setHealthy(healthy: boolean): void;
  /** Make the next call, whichever it is, throw the given error. */
  failNextWith(error: Error): void;
  /** Forget every link, session and instruction. */
  reset(): void;
}

interface SeededLink {
  account: LinkedAccount;
  unresolvedLookups: number;
  lookups: number;
}

export function createFakeViaClient(): FakeViaClient {
  const links = new Map<string, SeededLink>();
  const sessions: OpenedSession[] = [];
  const calls: string[] = [];
  const rsos = new Map<number, Rso>(RECORDED_RSOS.map(rso => [rso.rsoId, { ...rso }]));
  const events = new Map<number, ViaEvent>([[RECORDED_EVENT.eventId, { ...RECORDED_EVENT }]]);
  const outbox: OutboxEntry[] = [];
  const interests: RecordedInterest[] = [];
  /** Who has marked interest in each event, so that one person counts once. */
  const interested = new Map<number, Set<string>>();
  let healthy = true;
  let nextFailure: Error | null = null;
  let sessionCounter = 0;

  /** One instruction, one failure, so a test can assert on the recovery too. */
  function throwIfInstructed(): void {
    if (!nextFailure) return;
    const failure = nextFailure;
    nextFailure = null;
    throw failure;
  }

  /**
   * Which organizations the acting person may be shown internal events for.
   * Nobody, when there is no link, and every organization for a global
   * administrator, which is exactly what the reading router decides.
   */
  function internalRsosFor(discordUserId: string | undefined): 'all' | number[] {
    if (!discordUserId) return [];
    const seeded = links.get(discordUserId);
    if (!seeded) return [];
    if (seeded.account.isGlobalAdmin) return 'all';
    return seeded.account.memberships.map(membership => membership.rsoId);
  }

  function maySee(event: ViaEvent, discordUserId: string | undefined): boolean {
    if (!event.isPrivate) return true;
    const visible = internalRsosFor(discordUserId);
    return visible === 'all' || visible.includes(event.rsoId);
  }

  /** The instant a wall clock reading names, for the window a listing asks for. */
  function instantOf(value: string): number {
    return Date.parse(value);
  }

  function matchingEvents(query: EventQuery): ViaEvent[] {
    const asked = query.includeInternal === true;
    return [...events.values()]
      .filter(event => !query.rsoIds || query.rsoIds.length === 0 || query.rsoIds.includes(event.rsoId))
      .filter(event => !event.isPrivate || (asked && maySee(event, query.actingDiscordUserId)))
      .filter(event => !query.from || instantOf(event.startTime) >= instantOf(`${query.from}T00:00:00-05:00`))
      .filter(event => !query.to || instantOf(event.startTime) <= instantOf(`${query.to}T23:59:59-05:00`))
      .sort((left, right) => instantOf(left.startTime) - instantOf(right.startTime));
  }

  return {
    sessions,
    calls,
    interests,

    seedOutbox(kind, overrides = {}) {
      const recorded = RECORDED_OUTBOX.get(kind);
      if (!recorded) {
        throw new Error(`The web platform does not write an outbox entry of the kind ${kind}.`);
      }
      const entry: OutboxEntry = {
        ...recorded,
        payload: { ...recorded.payload },
        ...overrides,
        outboxId: overrides.outboxId ?? outbox.length + 1,
        kind,
      };
      outbox.push(entry);
      return entry;
    },

    clearOutbox() {
      outbox.length = 0;
    },

    seedRso(overrides = {}) {
      const template = RECORDED_RSOS[0]!;
      const rso: Rso = { ...template, ...overrides };
      rsos.set(rso.rsoId, rso);
      return rso;
    },

    seedEvent(overrides = {}) {
      const event: ViaEvent = { ...RECORDED_EVENT, ...overrides };
      events.set(event.eventId, event);
      return event;
    },

    clearRsos() {
      rsos.clear();
    },

    clearEvents() {
      events.clear();
    },

    seedLink(discordUserId, overrides = {}, timing = {}) {
      const account: LinkedAccount = {
        ...LINK_TEMPLATE,
        discordUserId,
        ...overrides,
        memberships: overrides.memberships ?? LINK_TEMPLATE.memberships.map(m => ({ ...m })),
      };
      links.set(discordUserId, {
        account,
        unresolvedLookups: timing.afterLookups ?? 0,
        lookups: 0,
      });
      return account;
    },

    removeLink(discordUserId) {
      links.delete(discordUserId);
    },

    setHealthy(value) {
      healthy = value;
    },

    failNextWith(error) {
      nextFailure = error;
    },

    reset() {
      links.clear();
      sessions.length = 0;
      calls.length = 0;
      outbox.length = 0;
      interests.length = 0;
      interested.clear();
      healthy = true;
      nextFailure = null;
      sessionCounter = 0;
      rsos.clear();
      for (const rso of RECORDED_RSOS) rsos.set(rso.rsoId, { ...rso });
      events.clear();
      events.set(RECORDED_EVENT.eventId, { ...RECORDED_EVENT });
    },

    async openLinkSession(discordUserId) {
      throwIfInstructed();
      sessionCounter += 1;
      const sessionId = `${SESSION_TEMPLATE.sessionId.slice(0, 40)}${String(sessionCounter).padStart(3, '0')}`;
      const session: LinkSession = {
        sessionId,
        address: `https://viaillinois.com/link/discord/${sessionId}`,
        expiresAt: SESSION_TEMPLATE.expiresAt,
      };
      sessions.push({ discordUserId, session });
      return session;
    },

    async getLink(discordUserId) {
      throwIfInstructed();
      const seeded = links.get(discordUserId);
      if (!seeded) return null;
      seeded.lookups += 1;
      if (seeded.lookups <= seeded.unresolvedLookups) return null;
      return seeded.account;
    },

    async unlink(discordUserId) {
      throwIfInstructed();
      return links.delete(discordUserId);
    },

    async listRsos() {
      throwIfInstructed();
      calls.push('listRsos');
      return [...rsos.values()].map(rso => ({ ...rso }));
    },

    async getRso(rsoId, actingDiscordUserId) {
      throwIfInstructed();
      calls.push('getRso');
      const rso = rsos.get(rsoId);
      if (!rso) return null;
      const upcoming = matchingEvents({ rsoIds: [rsoId], includeInternal: true, actingDiscordUserId });
      const answer: RsoWithEvents = { rso: { ...rso }, events: upcoming.slice(0, 5).map(e => ({ ...e })) };
      return answer;
    },

    async listEvents(query) {
      throwIfInstructed();
      calls.push('listEvents');
      const matching = matchingEvents(query);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? matching.length;
      const page: EventPage = {
        events: matching.slice(offset, offset + limit).map(event => ({ ...event })),
        total: matching.length,
      };
      return page;
    },

    async getEvent(eventId, actingDiscordUserId) {
      throwIfInstructed();
      calls.push('getEvent');
      const event = events.get(eventId);
      if (!event || !maySee(event, actingDiscordUserId)) return null;
      return { ...event };
    },

    /**
     * The calendar file is the recorded one with this event's identifier and
     * title written into it, which is enough for a test that asserts on the
     * attachment without turning the fake into a second calendar builder.
     */
    async getEventCalendar(eventId) {
      throwIfInstructed();
      calls.push('getEventCalendar');
      const event = events.get(eventId);
      if (!event) {
        throw new ViaError('There is no event with that identifier.', 404, 'not_found');
      }
      return RECORDED_CALENDAR
        .replace('via-event-10@viaillinois.com', `via-event-${event.eventId}@viaillinois.com`)
        .replace('SUMMARY:General meeting', `SUMMARY:${event.title}`);
    },

    /**
     * The rule the web platform applies, applied here so that a command can be
     * tested against all three of its answers: a confirmation, a refusal for
     * somebody who is not on that board, and a refusal for somebody who has no
     * VIA account at all.
     */
    async confirmBinding(rsoId, actingDiscordUserId) {
      throwIfInstructed();
      calls.push('confirmBinding');
      const seeded = links.get(actingDiscordUserId);
      if (!seeded) {
        throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
      }
      const onBoard = seeded.account.memberships
        .some(membership => membership.rsoId === rsoId && membership.role === 'board');
      if (!seeded.account.isGlobalAdmin && !onBoard) {
        throw new ViaError(
          'You are not on the board of that organization, so you cannot bind a server to it.',
          403,
          'forbidden',
        );
      }
    },

    /**
     * The entries after the cursor, in order, which is what the consumer
     * polls for. The next cursor is the identifier of the last entry served,
     * so a page that stopped at the limit is asked for again from there.
     */
    async readOutbox(query: OutboxQuery): Promise<OutboxPage> {
      throwIfInstructed();
      calls.push('readOutbox');
      const after = query.after ?? 0;
      const matching = outbox.filter(entry => entry.outboxId > after);
      const served = query.limit === undefined ? matching : matching.slice(0, query.limit);
      return {
        entries: served.map(entry => ({ ...entry })),
        nextAfter: served.length > 0 ? served[served.length - 1]!.outboxId : null,
      };
    },

    /**
     * Interest is counted per person, so pressing the button twice counts
     * once, exactly as the web platform's own key over the event and the
     * person does. The fake does not hash anything, because hashing is the
     * web platform's and the bot never sees the result.
     */
    async setInterest(eventId: number, interest: InterestSignal): Promise<InterestAnswer> {
      throwIfInstructed();
      calls.push('setInterest');
      interests.push({
        eventId,
        interested: interest.interested,
        ...(interest.actingDiscordUserId ? { actingDiscordUserId: interest.actingDiscordUserId } : {}),
        ...(interest.discordUserId ? { discordUserId: interest.discordUserId } : {}),
      });

      const event = events.get(eventId);
      if (!event) {
        throw new ViaError('There is no event with that identifier.', 404, 'not_found');
      }
      const who = interest.actingDiscordUserId ?? interest.discordUserId ?? 'somebody';
      if (!interested.has(eventId)) interested.set(eventId, new Set());
      const marked = interested.get(eventId)!;

      if (interest.interested && !marked.has(who)) {
        marked.add(who);
        event.interestCount += 1;
      }
      if (!interest.interested && marked.has(who)) {
        marked.delete(who);
        event.interestCount -= 1;
      }
      return { ok: true, interestCount: event.interestCount };
    },

    async health() {
      throwIfInstructed();
      return healthy;
    },
  };
}
