import { readFileSync } from 'node:fs';
import {
  ViaError, parseBuilding, parseCourses, parseEvent, parseLinkSession, parseLinkedAccount,
  parseLocations, parseMidterms, parseOutboxEntry, parsePersonalCalendar, parseRsoMembers,
  parseRsos, parseScheduleRecommendations,
  type ViaClient, type Building, type CampusLocation, type Course, type EventChanges,
  type EventPage, type EventQuery, type FreeRooms, type FreeRoomQuery, type InterestAnswer,
  type InterestSignal, type LinkSession, type LinkedAccount, type Midterm, type MidtermQuery,
  type OutboxEntry, type OutboxPage, type OutboxQuery, type PersonalCalendar, type Postponement,
  type Rso, type RsoMember, type RsoWithEvents, type ScheduleRecommendations, type ScheduleRequest,
  type SeriesCreated, type SeriesRequest, type ViaEvent,
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
/** The recorded personal calendar, whose address shape every answer follows. */
const CALENDAR_TEMPLATE = parsePersonalCalendar(fixture('calendars.personal.json'));

/** The recorded midterm, which is what the fake lists until a test seeds more. */
const RECORDED_MIDTERM = parseMidterms(fixture('midterms.json'))[0]!;
/** The recorded course, with the section the contract test recorded on it. */
const RECORDED_COURSE = parseCourses(fixture('courses.json'))[0]!;
/** The recorded room, which is what the fake searches until a test seeds more. */
const RECORDED_LOCATION = parseLocations(fixture('locations.json'))[0]!;
/** The recorded building, whose code and name every building answer follows. */
const RECORDED_BUILDING = parseBuilding(fixture('building.json'));
/** The recorded member, which is who the fake lists until a test seeds more. */
const RECORDED_MEMBER = parseRsoMembers(fixture('rsoMembers.json'))[0]!;
/** The recorded recommendation, which the fake answers the scheduler with. */
const RECORDED_RECOMMENDATIONS = parseScheduleRecommendations(fixture('scheduler.recommend.json'));

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

/** The longest window the reading router's free room search will look at. */
const MAX_FREE_ROOM_DAYS = 7;

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

/** One postponement the fake was given, as it was given. */
export interface RecordedPostponement {
  eventId: number;
  reason: string | null;
}

/** One person's calendar, as the fake holds it. */
export interface SeededPersonalCalendar extends PersonalCalendar {
  /** The organizations the calendar carries, or null for every one of them. */
  rsoIds: number[] | null;
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
  /** The calendar the fake holds for a person, or null when they have none. */
  personalCalendarOf(discordUserId: string): SeededPersonalCalendar | null;
  /** Add or replace a midterm, filling anything unnamed from the recorded one. */
  seedMidterm(overrides?: Partial<Midterm>): Midterm;
  /** Forget every midterm, for a test about a term with no exams recorded. */
  clearMidterms(): void;
  /** Add or replace a course, filling anything unnamed from the recorded one. */
  seedCourse(overrides?: Partial<Course>): Course;
  /** Forget every course, for a test about a catalogue that has not been polled. */
  clearCourses(): void;
  /** Add or replace a room, filling anything unnamed from the recorded one. */
  seedLocation(overrides?: Partial<CampusLocation>): CampusLocation;
  /** Forget every room, for a test about a building with nothing recorded in it. */
  clearLocations(): void;
  /** Add or replace a building code, filling anything unnamed from the recorded one. */
  seedBuilding(overrides?: Partial<Building>): Building;
  /**
   * Say that a room is in use, so that a free room search leaves it out. The
   * web platform works this out from course sections, facility reservations
   * and VIA events, and the fake takes the answer as given, because what a
   * command needs is a room that is free and a room that is not.
   */
  occupyRoom(locationId: number): void;
  /** Every postponement the fake was given, in order, with the reason it carried. */
  readonly postponements: RecordedPostponement[];
  /** Every question the scheduler was asked, in order. */
  readonly scheduleRequests: ScheduleRequest[];
  /** Every repeat the fake was asked to create, in order. */
  readonly seriesRequests: SeriesRequest[];
  /** Replace what the scheduler answers, for a test about an answer that has changed. */
  seedRecommendations(answer: ScheduleRecommendations): void;
  /** Add or replace a member of an organization, filling anything unnamed from the recorded one. */
  seedMember(rsoId: number, overrides?: Partial<RsoMember>): RsoMember;
  /** Forget every member of an organization, for a test about a board nobody is on. */
  clearMembers(rsoId: number): void;
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
  const calendars = new Map<string, SeededPersonalCalendar>();
  const midterms = new Map<number, Midterm>([[RECORDED_MIDTERM.midtermId, { ...RECORDED_MIDTERM }]]);
  const courses = new Map<string, Course>([[RECORDED_COURSE.courseCode, { ...RECORDED_COURSE }]]);
  const locations = new Map<number, CampusLocation>([[RECORDED_LOCATION.locationId, { ...RECORDED_LOCATION }]]);
  const buildings = new Map<string, Building>([[RECORDED_BUILDING.code, { ...RECORDED_BUILDING }]]);
  const occupied = new Set<number>();
  const members = new Map<number, Map<string, RsoMember>>([
    [1, new Map([[RECORDED_MEMBER.netId, { ...RECORDED_MEMBER }]])],
  ]);
  const postponements: RecordedPostponement[] = [];
  const scheduleRequests: ScheduleRequest[] = [];
  const seriesRequests: SeriesRequest[] = [];
  let recommendations: ScheduleRecommendations = RECORDED_RECOMMENDATIONS;
  let healthy = true;
  let nextEventId = 1000;
  let nextSeriesId = 100;
  let nextFailure: Error | null = null;
  let sessionCounter = 0;
  let calendarCounter = 0;

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

  /**
   * Who may act on an organization's events, which is the rule the web
   * platform applies rather than a shape it sends. An editor or a board member
   * of that organization may, a global administrator may everywhere, and
   * anybody else is refused with the code the bot branches on.
   */
  function requireEditor(rsoId: number, actingDiscordUserId: string): void {
    const seeded = links.get(actingDiscordUserId);
    if (!seeded) {
      throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
    }
    if (seeded.account.isGlobalAdmin) return;
    const allowed = seeded.account.memberships.some(membership =>
      membership.rsoId === rsoId
      && (membership.role === 'editor' || membership.role === 'board' || membership.role === 'admin'));
    if (!allowed) {
      throw new ViaError(
        'You are not an editor of that organization, so you cannot change its events.',
        403,
        'forbidden',
      );
    }
  }

  /** Reading an organization's members is board work, which is a narrower rule. */
  function requireBoard(rsoId: number, actingDiscordUserId: string): void {
    const seeded = links.get(actingDiscordUserId);
    if (!seeded) {
      throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
    }
    if (seeded.account.isGlobalAdmin) return;
    const allowed = seeded.account.memberships.some(membership =>
      membership.rsoId === rsoId && (membership.role === 'board' || membership.role === 'admin'));
    if (!allowed) {
      throw new ViaError(
        'You are not on the board of that organization, so you cannot read its members.',
        403,
        'forbidden',
      );
    }
  }

  /**
   * A time an acting call carries, in the shape the web platform's own wall
   * clock reader takes: a date and a time, with the seconds optional, written
   * back with the seconds it stores. The reading endpoints parse dates more
   * narrowly, which is why this is a reader of its own rather than the one
   * above.
   */
  const ACTING_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

  function actingWallClock(raw: string): string {
    const text = String(raw ?? '').trim();
    if (!ACTING_WALL_CLOCK.test(text)) {
      throw new ViaError(
        'Each time has to be written as a date and a time, such as 2026-09-17 18:00.',
        400,
        'invalid',
      );
    }
    const normalized = text.replace('T', ' ');
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  }

  /** The event an acting call names, or the refusal that says it is not there. */
  function eventFor(eventId: number, actingDiscordUserId: string): ViaEvent {
    const event = events.get(eventId);
    if (!event) {
      throw new ViaError('There is no event with that identifier.', 404, 'not_found');
    }
    requireEditor(event.rsoId, actingDiscordUserId);
    return event;
  }

  /**
   * A wall clock reading in the shape the reading router parses, or the
   * refusal it answers with. The fake applies the rule rather than the
   * spelling: what a command has to handle is the refusal.
   */
  const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?$/;

  function wallClock(raw: string): string {
    if (!WALL_CLOCK.test(raw)) {
      throw new ViaError(
        'A date has to be written as YYYY-MM-DD, or as YYYY-MM-DD HH:MM:SS for a time of day.',
        400,
        'invalid',
      );
    }
    return raw.replace('T', ' ');
  }

  /**
   * The building a search term names, expanded from a code where it is one,
   * exactly as the reading router does, so that ECEB and the full name reach
   * the same rooms.
   */
  function canonicalBuilding(term: string): string {
    return buildings.get(term.trim().toUpperCase())?.name ?? term.trim();
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

    seedMidterm(overrides = {}) {
      const midterm: Midterm = { ...RECORDED_MIDTERM, ...overrides };
      midterms.set(midterm.midtermId, midterm);
      return midterm;
    },

    clearMidterms() {
      midterms.clear();
    },

    seedCourse(overrides = {}) {
      const course: Course = {
        ...RECORDED_COURSE,
        ...overrides,
        sections: overrides.sections ?? RECORDED_COURSE.sections.map(section => ({ ...section })),
      };
      courses.set(course.courseCode, course);
      return course;
    },

    clearCourses() {
      courses.clear();
    },

    seedLocation(overrides = {}) {
      const location: CampusLocation = { ...RECORDED_LOCATION, ...overrides };
      locations.set(location.locationId, location);
      return location;
    },

    clearLocations() {
      locations.clear();
    },

    seedBuilding(overrides = {}) {
      const building: Building = { ...RECORDED_BUILDING, ...overrides };
      buildings.set(building.code, building);
      return building;
    },

    occupyRoom(locationId) {
      occupied.add(locationId);
    },

    postponements,
    scheduleRequests,
    seriesRequests,

    seedRecommendations(answer) {
      recommendations = answer;
    },

    seedMember(rsoId, overrides = {}) {
      const member: RsoMember = { ...RECORDED_MEMBER, ...overrides };
      if (!members.has(rsoId)) members.set(rsoId, new Map());
      members.get(rsoId)!.set(member.netId, member);
      return member;
    },

    clearMembers(rsoId) {
      members.set(rsoId, new Map());
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

    personalCalendarOf(discordUserId) {
      const held = calendars.get(discordUserId);
      return held ? { ...held, rsoIds: held.rsoIds === null ? null : [...held.rsoIds] } : null;
    },

    reset() {
      links.clear();
      calendars.clear();
      calendarCounter = 0;
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
      midterms.clear();
      midterms.set(RECORDED_MIDTERM.midtermId, { ...RECORDED_MIDTERM });
      courses.clear();
      courses.set(RECORDED_COURSE.courseCode, { ...RECORDED_COURSE });
      locations.clear();
      locations.set(RECORDED_LOCATION.locationId, { ...RECORDED_LOCATION });
      buildings.clear();
      buildings.set(RECORDED_BUILDING.code, { ...RECORDED_BUILDING });
      occupied.clear();
      members.clear();
      members.set(1, new Map([[RECORDED_MEMBER.netId, { ...RECORDED_MEMBER }]]));
      postponements.length = 0;
      scheduleRequests.length = 0;
      seriesRequests.length = 0;
      recommendations = RECORDED_RECOMMENDATIONS;
      nextEventId = 1000;
      nextSeriesId = 100;
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

    /**
     * The calendar belongs to a linked person, which is what the acting header
     * names, and asking for it again rotates the token. The token itself is a
     * counter here rather than anything random, so that a test can read the
     * address it was given and see that a second call changed it.
     */
    async createPersonalCalendar(rsoIds, actingDiscordUserId) {
      throwIfInstructed();
      calls.push('createPersonalCalendar');
      if (!links.has(actingDiscordUserId)) {
        throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
      }
      calendarCounter += 1;
      const token = String(calendarCounter).padStart(32, '0');
      const calendar: SeededPersonalCalendar = {
        address: CALENDAR_TEMPLATE.address.replace(/[^/]+\.ics$/, `${token}.ics`),
        rotatedAt: CALENDAR_TEMPLATE.rotatedAt,
        rsoIds: rsoIds === null ? null : [...rsoIds],
      };
      calendars.set(actingDiscordUserId, calendar);
      return { address: calendar.address, rotatedAt: calendar.rotatedAt };
    },

    async updatePersonalCalendarRsos(rsoIds, actingDiscordUserId) {
      throwIfInstructed();
      calls.push('updatePersonalCalendarRsos');
      const held = calendars.get(actingDiscordUserId);
      if (!held) {
        throw new ViaError('This VIA account has no personal calendar.', 404, 'not_found');
      }
      calendars.set(actingDiscordUserId, { ...held, rsoIds: rsoIds === null ? null : [...rsoIds] });
    },

    /**
     * The exams of a course, or of a window, in the order they happen. A
     * cancelled exam is left out, which is what the reading router's own
     * condition over the status does.
     */
    async listMidterms(query: MidtermQuery = {}): Promise<Midterm[]> {
      throwIfInstructed();
      calls.push('listMidterms');
      const from = query.from ? Date.parse(`${query.from.slice(0, 10)}T00:00:00-05:00`) : null;
      const to = query.to ? Date.parse(`${query.to.slice(0, 10)}T23:59:59-05:00`) : null;

      return [...midterms.values()]
        .filter(midterm => midterm.status !== 'cancelled')
        .filter(midterm => !query.course || midterm.courseCode === query.course)
        .filter(midterm => from === null || Date.parse(midterm.startTime) >= from)
        .filter(midterm => to === null || Date.parse(midterm.startTime) <= to)
        .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
        .map(midterm => ({ ...midterm }));
    },

    /**
     * A search box that lists the whole catalogue before a key is pressed is
     * not a search box, so an empty term answers nothing, as the reading
     * router does.
     */
    async searchCourses(term: string, options: { sections?: boolean } = {}): Promise<Course[]> {
      throwIfInstructed();
      calls.push('searchCourses');
      const typed = term.trim().toLowerCase();
      if (!typed) return [];

      return [...courses.values()]
        .filter(course => course.courseCode.toLowerCase().includes(typed)
          || (course.title ?? '').toLowerCase().includes(typed))
        .sort((left, right) => left.courseCode.localeCompare(right.courseCode))
        .map(course => ({
          ...course,
          sections: options.sections ? course.sections.map(section => ({ ...section })) : [],
        }));
    },

    async searchLocations(term: string): Promise<CampusLocation[]> {
      throwIfInstructed();
      calls.push('searchLocations');
      const typed = term.trim();
      if (!typed) return [];
      const wanted = canonicalBuilding(typed).toLowerCase();

      return [...locations.values()]
        .filter(location => location.building.toLowerCase().includes(wanted)
          || (location.roomNumber ?? '').toLowerCase().includes(wanted))
        .map(location => ({ ...location }));
    },

    /**
     * The rooms of a building with nothing in them, with the two refusals the
     * reading router answers with: a date it cannot parse, and a window longer
     * than the seven days its day by day scan is bounded to.
     */
    async freeRooms(query: FreeRoomQuery): Promise<FreeRooms> {
      throwIfInstructed();
      calls.push('freeRooms');
      if (!query.building.trim()) {
        throw new ViaError('A building is required, by code or by name.', 400, 'invalid');
      }
      const from = wallClock(query.from);
      const to = wallClock(query.to);
      if (from >= to) {
        throw new ViaError(
          'A window needs a from and a to, and the to has to come after the from.',
          400,
          'invalid',
        );
      }
      const days = (Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
        - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
      if (days > MAX_FREE_ROOM_DAYS) {
        throw new ViaError(`A window can cover at most ${MAX_FREE_ROOM_DAYS} days.`, 400, 'invalid');
      }

      const building = canonicalBuilding(query.building);
      return {
        building,
        from,
        to,
        locations: [...locations.values()]
          .filter(location => location.building === building)
          .filter(location => !occupied.has(location.locationId))
          .sort((left, right) => (left.roomNumber ?? '').localeCompare(right.roomNumber ?? ''))
          .map(location => ({ ...location })),
      };
    },

    async getBuilding(code: string): Promise<Building | null> {
      throwIfInstructed();
      calls.push('getBuilding');
      const held = buildings.get(code.trim().toUpperCase());
      return held ? { ...held } : null;
    },

    /**
     * The acting endpoints. Each of them applies the web platform's rule about
     * who may act and then changes the event the fake holds, so a command test
     * can read the event back and see what the person's action did.
     */
    async postponeEvent(eventId: number, postponement: Postponement, actingDiscordUserId: string) {
      throwIfInstructed();
      calls.push('postponeEvent');
      const event = eventFor(eventId, actingDiscordUserId);
      const start = actingWallClock(postponement.startTime);
      const end = actingWallClock(postponement.endTime);
      if (end <= start) {
        throw new ViaError('The end time has to come after the start time.', 400, 'invalid');
      }
      event.startTime = start;
      event.endTime = end;
      postponements.push({ eventId, reason: (postponement.reason ?? '').trim() || null });
      return { ...event };
    },

    async cancelEvent(eventId: number, actingDiscordUserId: string) {
      throwIfInstructed();
      calls.push('cancelEvent');
      const event = eventFor(eventId, actingDiscordUserId);
      event.cancelledAt = '2026-09-05T12:00:00-05:00';
      return event.cancelledAt;
    },

    async patchEvent(eventId: number, changes: EventChanges, actingDiscordUserId: string) {
      throwIfInstructed();
      calls.push('patchEvent');
      const event = eventFor(eventId, actingDiscordUserId);
      if ('description' in changes) event.description = changes.description ?? null;
      if ('isPrivate' in changes) event.isPrivate = Boolean(changes.isPrivate);
      if ('locationNote' in changes) event.locationNote = changes.locationNote ?? null;
      return { ...event };
    },

    /**
     * The recorded recommendation, for an editor of the organization the
     * request names. What the scheduler weighs is the web platform's, and a
     * fake that weighed it differently would be a second scheduler to keep in
     * step with the first.
     */
    async recommendSchedule(
      request: ScheduleRequest,
      actingDiscordUserId: string,
    ): Promise<ScheduleRecommendations> {
      throwIfInstructed();
      calls.push('recommendSchedule');
      requireEditor(request.rsoId, actingDiscordUserId);
      scheduleRequests.push(request);
      return {
        curatedPicks: recommendations.curatedPicks.map(pick => ({ ...pick })),
        allOptions: recommendations.allOptions.map(option => ({ ...option })),
      };
    },

    /**
     * A repeat, expanded weekly from the first meeting to the end date, which
     * is enough of what the web platform's own planner does for a command to
     * be tested against the events it leaves behind.
     */
    async createEventSeries(
      request: SeriesRequest,
      actingDiscordUserId: string,
    ): Promise<SeriesCreated> {
      throwIfInstructed();
      calls.push('createEventSeries');
      requireEditor(request.rsoId, actingDiscordUserId);
      seriesRequests.push(request);

      const start = actingWallClock(request.startTime);
      const end = actingWallClock(request.endTime);
      if (end <= start) {
        throw new ViaError('The end time has to be after the start time.', 400, 'invalid');
      }

      const endsOn = request.recurrence.endsOn ?? start.slice(0, 10);
      const everyDays = 7 * Math.max(1, request.recurrence.intervalWeeks);
      const day = (value: string, plus: number) =>
        new Date(Date.parse(`${value}T12:00:00Z`) + plus * 86_400_000).toISOString().slice(0, 10);

      const seriesId = (nextSeriesId += 1);
      const eventIds: number[] = [];
      for (let date = start.slice(0, 10); date <= endsOn; date = day(date, everyDays)) {
        const eventId = (nextEventId += 1);
        const rso = rsos.get(request.rsoId);
        const location = request.locationId === undefined || request.locationId === null
          ? null
          : locations.get(request.locationId) ?? null;
        events.set(eventId, {
          ...RECORDED_EVENT,
          eventId,
          rsoId: request.rsoId,
          rsoName: rso?.name ?? null,
          title: request.title,
          description: request.description ?? null,
          startTime: `${date} ${start.slice(11)}`,
          endTime: `${date} ${end.slice(11)}`,
          isPrivate: Boolean(request.isPrivate),
          cancelledAt: null,
          locationId: location?.locationId ?? null,
          building: location?.building ?? null,
          roomNumber: location?.roomNumber ?? null,
          locationText: request.locationText ?? null,
          locationNote: null,
          seriesId,
          seriesFrequency: 'weekly',
          seriesIntervalWeeks: request.recurrence.intervalWeeks,
          seriesDaysOfWeek: [...request.recurrence.daysOfWeek].join(','),
          seriesEndsOn: endsOn,
          interestCount: 0,
        });
        eventIds.push(eventId);
      }

      if (eventIds.length === 0) {
        throw new ViaError(
          'That repeat produces no events. Check the days of the week and the end date.',
          400,
          'invalid',
        );
      }
      return { seriesId, eventIds, created: eventIds.length, skipped: [] };
    },

    async listRsoMembers(rsoId: number, actingDiscordUserId: string): Promise<RsoMember[]> {
      throwIfInstructed();
      calls.push('listRsoMembers');
      requireBoard(rsoId, actingDiscordUserId);
      return [...(members.get(rsoId)?.values() ?? [])].map(member => ({ ...member }));
    },

    async health() {
      throwIfInstructed();
      return healthy;
    },
  };
}
