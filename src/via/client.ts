import { campusStamp, toInstant } from '../render/campusTime.ts';
/**
 * The web platform client.
 *
 * Every piece of VIA data the bot reads or writes goes through the internal
 * service API, and every call to that API goes through this interface. Two
 * implementations exist: the real one over HTTP in `http.ts`, and the in
 * memory one in `fake.ts` that serves the recorded shapes under
 * `tests/fixtures/internal`. Commands are written against the interface, so
 * almost every test needs neither the web platform nor Discord.
 *
 * The interface grows one increment at a time. The first increment needed the
 * three link endpoints and a health check. The second adds the reading
 * endpoints the event commands answer from, the binding confirmation, which is
 * the one setup step the web platform decides rather than Discord, the outbox
 * the consumer reads, and the interest signal the announcements and the
 * scheduled event mirror record.
 */

/**
 * The machine readable codes the internal service API answers refusals with,
 * from section 3 of the companion specification, and one code of the bot's
 * own for the case where nothing answered at all.
 */
export const VIA_ERROR_CODES = [
  'unauthorized',
  'not_linked',
  'forbidden',
  'not_found',
  'invalid',
  'busy',
  'conflict',
  'unreachable',
] as const;

export type ViaErrorCode = (typeof VIA_ERROR_CODES)[number];

/**
 * A refusal from the web platform, or a failure to reach it.
 *
 * The message is the sentence the web platform wrote, which is fit to show a
 * person, and the code is what the bot branches on, so no caller ever has to
 * read prose to tell a missing link from a missing event.
 */
export class ViaError extends Error {
  readonly status: number;
  readonly code: ViaErrorCode;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: ViaErrorCode, requestId: string | null = null) {
    super(message);
    this.name = 'ViaError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * The web platform is shedding load and named a wait. The bot honours the
 * wait and does not retry inside it, so this is thrown only after one retry
 * has already been made and refused.
 */
export class ViaBusyError extends ViaError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, requestId: string | null = null) {
    super(message, 503, 'busy', requestId);
    this.name = 'ViaBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The three membership roles the web platform keeps in RSO_Memberships. */
export type MembershipRole = 'member' | 'editor' | 'board' | 'admin';

/** One RSO a linked person belongs to, with the role they hold in it. */
export interface Membership {
  rsoId: number;
  rsoName: string;
  role: MembershipRole;
}

/**
 * A link session the person opens in a browser to sign in with their NetID
 * and authorize the bot's Discord application. It expires ten minutes after
 * the web platform created it.
 */
export interface LinkSession {
  sessionId: string;
  address: string;
  expiresAt: string;
}

/**
 * A resolved link. The bot holds this only for as long as it is answering the
 * interaction that asked for it: the NetID belongs to the web platform, and
 * nothing here is written to the bot's database.
 */
export interface LinkedAccount {
  discordUserId: string;
  netId: string;
  displayName: string;
  isGlobalAdmin: boolean;
  linkedAt: string;
  memberships: Membership[];
}

/** One organization, as the reading endpoints answer it. */
export interface Rso {
  rsoId: number;
  name: string;
  description: string | null;
  /** The colour the website draws the organization in, when it has one. */
  logoColor: string | null;
}

/**
 * One event, in the single shape every reading endpoint answers with, so a
 * row in a list and an event's own answer are the same object. The series
 * fields describe the pattern an event belongs to, and are null for an event
 * that stands on its own. Times carry the campus offset, as the web platform
 * sends them.
 */
export interface ViaEvent {
  eventId: number;
  rsoId: number;
  rsoName: string | null;
  title: string;
  description: string | null;
  startTime: string;
  endTime: string;
  /** Whether the organization marked the event internal to its own members. */
  isPrivate: boolean;
  /** When the event was cancelled, which is a state of its own rather than a delete. */
  cancelledAt: string | null;
  locationId: number | null;
  building: string | null;
  roomNumber: string | null;
  /** A place written by hand, for an event that is not in a room VIA knows. */
  locationText: string | null;
  /** A short note a board attached to the event, such as which entrance to use. */
  locationNote: string | null;
  seriesId: number | null;
  seriesFrequency: string | null;
  seriesIntervalWeeks: number | null;
  seriesDaysOfWeek: string | null;
  seriesEndsOn: string | null;
  interestCount: number;
}

/** Which timeframe of the feed a listing asks for, as the website names them. */
export type EventTimeframe = 'upcoming' | 'archived' | 'all';

/**
 * What a listing asks for. Every field is optional, because the web platform's
 * reading router has its own defaults and the bot sends only what it was
 * actually asked for. From and to are campus wall clock, as YYYY-MM-DD or as
 * YYYY-MM-DD HH:MM:SS, which is what the router parses.
 */
export interface EventQuery {
  rsoIds?: readonly number[];
  from?: string;
  to?: string;
  timeframe?: EventTimeframe;
  /**
   * Whether to ask for the events an organization marked internal. The web
   * platform decides who actually sees them, from the acting person's
   * memberships, so asking is not the same as being shown any.
   */
  includeInternal?: boolean;
  limit?: number;
  offset?: number;
  /** The person the bot is acting for, which is what internal visibility turns on. */
  actingDiscordUserId?: string;
}

export interface EventPage {
  events: ViaEvent[];
  /** How many events match the filters, which is what the page control counts. */
  total: number;
}

export interface RsoWithEvents {
  rso: Rso;
  events: ViaEvent[];
}

/**
 * One entry of the outbox, which is how the web platform tells the bot that
 * something happened. The payload is a snapshot of the subject after the
 * change, so the common case needs no second call, and it is left as it
 * arrived because each kind carries a different shape. The three readers
 * below take it apart.
 */
export interface OutboxEntry {
  outboxId: number;
  /** One of the kinds in section 8 of the design, such as `event.created`. */
  kind: string;
  subjectType: string;
  subjectId: string;
  /** The organization the entry belongs to, so the bot routes without a lookup. */
  rsoId: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OutboxPage {
  entries: OutboxEntry[];
  /** The cursor to ask from next, or null when the outbox had nothing more. */
  nextAfter: number | null;
}

/** What the consumer asks the outbox for: everything after its cursor. */
export interface OutboxQuery {
  after: number;
  limit?: number;
}

/**
 * A series of meetings, as the series entries carry it. A series is one thing
 * rather than sixteen, which is why it has an outbox kind of its own and is
 * announced once.
 */
export interface ViaSeries {
  seriesId: number;
  rsoId: number;
  frequency: string | null;
  intervalWeeks: number | null;
  daysOfWeek: string | null;
  startsOn: string | null;
  endsOn: string | null;
  startOfDay: string | null;
  durationMinutes: number | null;
}

/**
 * What a series entry says: the pattern itself, the events that belong to it
 * now, and the events the change touched. A deletion leaves the first list
 * empty and names every event it removed in the second.
 */
export interface SeriesChange {
  series: ViaSeries;
  eventIds: number[];
  affectedEventIds: number[];
}

/** Whether interest is being set or cleared, and who by. */
export interface InterestSignal {
  interested: boolean;
  /**
   * The linked person the bot is acting for, which the web platform records
   * by NetID.
   */
  actingDiscordUserId?: string;
  /**
   * The Discord identifier of somebody who is not linked. The web platform
   * records a salted hash of it, as section 10 of the design requires, so the
   * count is honest and nobody can reverse it. The bot holds nothing.
   */
  discordUserId?: string;
}

export interface InterestAnswer {
  ok: boolean;
  /** How many people are interested in the event after the change. */
  interestCount: number;
}

/**
 * What one person thought of an event they went to: a score from one to five,
 * and a comment when they wrote one. The web platform holds one answer per
 * person and event, and a second answer replaces the first, so the comment
 * arrives as a second call carrying the same score.
 */
export interface EventFeedback {
  rating: number;
  comment?: string;
}

/**
 * The private calendar address a person subscribes to from their own calendar
 * application, and when its token was last rotated. The token lives in the
 * address, so asking for the calendar again is what rotating it means, and the
 * bot never stores either one.
 */
export interface PersonalCalendar {
  address: string;
  rotatedAt: string;
}

/**
 * One midterm, as the midterm endpoint answers it. The status is lowered as
 * the membership roles are, so nothing outside this module reads the web
 * platform's capitalisation. A midterm that is pending has a time somebody
 * has proposed and nobody has confirmed, which is the difference the answer a
 * student reads has to carry.
 */
export interface Midterm {
  midtermId: number;
  courseCode: string;
  courseTitle: string | null;
  /** What the exam is called, such as Midterm 1. */
  title: string | null;
  startTime: string;
  endTime: string;
  status: MidtermStatus;
  /** A place written by hand, for an exam that is not in a room VIA knows. */
  locationText: string | null;
  building: string | null;
  roomNumber: string | null;
}

/** The states a midterm can be in, as the web platform records them. */
export type MidtermStatus = 'confirmed' | 'pending' | 'cancelled';

/**
 * What a midterm listing asks for. Every field is optional, because the
 * reading router has its own defaults and the bot sends only what it was
 * asked for. From and to are campus wall clock, as YYYY-MM-DD or as
 * YYYY-MM-DD HH:MM:SS.
 */
export interface MidtermQuery {
  /** One course, by the code the web platform stores, such as ECE 385. */
  course?: string;
  from?: string;
  to?: string;
}

/** One meeting pattern of a course, as the courses poller recorded it. */
export interface CourseSection {
  sectionId: number;
  /** The days the section meets on, in the letters the timetable writes. */
  dayOfWeek: string | null;
  startTime: string | null;
  endTime: string | null;
  semester: string | null;
  sectionType: string | null;
  building: string | null;
  roomNumber: string | null;
}

/** One course, with its sections when they were asked for. */
export interface Course {
  courseCode: string;
  title: string | null;
  sections: CourseSection[];
}

/** One room VIA knows, as the location endpoints answer it. */
export interface CampusLocation {
  locationId: number;
  building: string;
  roomNumber: string | null;
  maxCapacity: number | null;
  hasAvEquipment: boolean;
}

/** What a free room search asks for: one building and one window. */
export interface FreeRoomQuery {
  /** The building, by code or by name, which the web platform canonicalizes. */
  building: string;
  from: string;
  to: string;
}

/**
 * The rooms of a building with nothing in them for a window. The building and
 * the window come back as the web platform read them, so an answer can say
 * which building it is actually about when somebody typed a code.
 */
export interface FreeRooms {
  building: string;
  from: string;
  to: string;
  locations: CampusLocation[];
}

/**
 * A building code and what it stands for. The address is null until the
 * university's own listing is recorded, and an answer that has none says so
 * rather than guessing at a street number.
 */
export interface Building {
  code: string;
  name: string;
  address: string | null;
}

/**
 * What a postponement changes. The two times are campus wall clock, as
 * YYYY-MM-DD HH:MM:SS or YYYY-MM-DD HH:MM, which is the shape the web
 * platform's own reader parses. The reason is optional and travels with the
 * change into the outbox entry, so an announcement can say why rather than
 * only that.
 */
export interface Postponement {
  startTime: string;
  endTime: string;
  reason?: string;
}

/**
 * The three fields an event can be changed by from Discord. Everything else
 * about an event is a decision with a room and a time in it, which belongs on
 * the dashboard where the conflicts can be shown. A field left out is left
 * alone, and a description or a note set to null is cleared.
 */
export interface EventChanges {
  description?: string | null;
  isPrivate?: boolean;
  locationNote?: string | null;
}

/** One person on an organization's board, as the members endpoint answers them. */
export interface RsoMember {
  /**
   * The NetID the web platform holds. The bot reads it to work out who a
   * membership is about and never writes it down: section 7 of the design
   * says the bot stores Discord identifiers and VIA identifiers and nothing
   * else that identifies a person.
   */
  netId: string;
  fullName: string | null;
  role: MembershipRole;
}

/**
 * What the scheduler is asked. This is the dashboard's own request, in the
 * spelling the scheduler route reads it in, because the bot asks the same
 * question the dashboard asks and the two surfaces have to weigh a candidate
 * the same way.
 */
export interface ScheduleRequest {
  /** The organization, which is what the web platform decides editorship against. */
  rsoId: number;
  durationMinutes: number;
  dateRange: { start: string; end: string };
  /** The window of the day a meeting may run in, by the hour. */
  timeConstraint?: { startHour: number; endHour: number } | null;
  /**
   * The repeat the search is for. A repeat that names no end runs to the end
   * of instruction, which the web platform fills in.
   */
  recurrence?: { intervalWeeks: number; daysOfWeek: readonly string[]; until?: string } | null;
}

/**
 * One evening the scheduler recommends: when it is, which room, what it
 * scored, why, and how the repeat behind it would run. The recurrence fields
 * are null for a search over one week, which asks about a single slot rather
 * than about a term of them.
 */
export interface ScheduleCandidate {
  /** Campus wall clock, as the scheduler works in. */
  startTime: string;
  endTime: string;
  locationId: number | null;
  building: string | null;
  roomNumber: string | null;
  maxCapacity: number | null;
  score: number;
  /** Why the scheduler weighed the slot as it did, in its own words. */
  reasons: string[];
  intervalWeeks: number | null;
  daysOfWeek: string[];
  /** How many weeks the repeat covers, and how many of them the room is free. */
  weeksTotal: number | null;
  weeksClear: number | null;
  /** The dates the room is taken, which the board reads before accepting. */
  conflicts: string[];
  /** The last date the repeat would run on. */
  until: string | null;
}

/**
 * What the scheduler answers: one slot per hour of the day it would pick, and
 * the wider list behind them. The dashboard shows both, and so does the bot.
 */
export interface ScheduleRecommendations {
  curatedPicks: ScheduleCandidate[];
  allOptions: ScheduleCandidate[];
}

/** What creating a repeat asks for, in the shape the series controller reads. */
export interface SeriesRequest {
  rsoId: number;
  title: string;
  description?: string | null;
  /** Campus wall clock for the first meeting. */
  startTime: string;
  endTime: string;
  isPrivate?: boolean;
  locationId?: number | null;
  locationText?: string | null;
  recurrence: {
    intervalWeeks: number;
    daysOfWeek: readonly string[];
    endsOn?: string;
    startsOn?: string;
  };
}

/** What was created, and which dates were left out because the room was taken. */
export interface SeriesCreated {
  seriesId: number;
  eventIds: number[];
  created: number;
  skipped: string[];
}

export interface ViaClient {
  /** Open a link session for a Discord account and get the address it opens. */
  openLinkSession(discordUserId: string): Promise<LinkSession>;
  /** The account a Discord user is linked to, or null when there is no link. */
  getLink(discordUserId: string): Promise<LinkedAccount | null>;
  /** Remove the link, answering whether there was one to remove. */
  unlink(discordUserId: string): Promise<boolean>;
  /** Every organization, for autocomplete and for community server setup. */
  listRsos(): Promise<Rso[]>;
  /** One organization with the events it has coming up, or null when there is none. */
  getRso(rsoId: number, actingDiscordUserId?: string): Promise<RsoWithEvents | null>;
  /** The events matching a listing, with how many there are in all. */
  listEvents(query: EventQuery): Promise<EventPage>;
  /** One event, or null when it does not exist or the person may not see it. */
  getEvent(eventId: number, actingDiscordUserId?: string): Promise<ViaEvent | null>;
  /** The event as a calendar file, which is the text of an .ics. */
  getEventCalendar(eventId: number): Promise<string>;
  /**
   * Ask the web platform whether the acting person may bind a server to an
   * organization. It answers by refusing, so this returns nothing and throws a
   * ViaError whose code is `not_linked` when the person has no VIA account and
   * `forbidden` when they have one but are not on that board.
   */
  confirmBinding(rsoId: number, actingDiscordUserId: string): Promise<void>;
  /** The outbox entries after the consumer's cursor, in the order they were written. */
  readOutbox(query: OutboxQuery): Promise<OutboxPage>;
  /** Set or clear one person's interest in an event, and read the count after it. */
  setInterest(eventId: number, interest: InterestSignal): Promise<InterestAnswer>;
  /**
   * Create the acting person's calendar, or rotate the token of the one they
   * have, and answer with the address. A set of null means every organization
   * in ECE.
   */
  createPersonalCalendar(rsoIds: readonly number[] | null, actingDiscordUserId: string): Promise<PersonalCalendar>;
  /**
   * Tell the web platform which organizations the acting person's calendar
   * carries, without rotating the token, which is what a change of follows
   * asks for.
   */
  updatePersonalCalendarRsos(rsoIds: readonly number[] | null, actingDiscordUserId: string): Promise<void>;
  /**
   * The midterms of a course, or of every course, in a window. Both confirmed
   * and pending exams come back, because a student deciding when to revise
   * needs to know that a date is not settled yet.
   */
  listMidterms(query?: MidtermQuery): Promise<Midterm[]>;
  /** The courses whose code or title matches what somebody typed. */
  searchCourses(term: string, options?: { sections?: boolean }): Promise<Course[]>;
  /** The rooms whose building or number matches what somebody typed. */
  searchLocations(term: string): Promise<CampusLocation[]>;
  /**
   * The rooms of a building with no course section, no facility reservation
   * and no VIA event overlapping the window, which is the web platform's own
   * conflict detection rather than anything worked out here.
   */
  freeRooms(query: FreeRoomQuery): Promise<FreeRooms>;
  /** What a building code stands for, or null when VIA does not know the code. */
  getBuilding(code: string): Promise<Building | null>;
  /**
   * The acting endpoints, which are the ones a person does something with.
   *
   * Every one of them names the acting Discord account and nothing else, and
   * every one of them can be refused with `not_linked` or `forbidden`. The bot
   * turns each refusal into the sentence the person reads and decides nothing
   * for itself, because who may act on an organization's events is the web
   * platform's answer and not the bot's.
   */
  postponeEvent(eventId: number, postponement: Postponement, actingDiscordUserId: string): Promise<ViaEvent | null>;
  /** Cancel one event, answering with the moment the web platform recorded. */
  cancelEvent(eventId: number, actingDiscordUserId: string): Promise<string | null>;
  /** Change the description, the visibility or the location note of one event. */
  patchEvent(eventId: number, changes: EventChanges, actingDiscordUserId: string): Promise<ViaEvent | null>;
  /**
   * Record what the acting person thought of an event they went to. The web
   * platform holds one answer per person and event, so a second call with the
   * same score and a comment replaces the first rather than adding to it.
   */
  recordFeedback(eventId: number, feedback: EventFeedback, actingDiscordUserId: string): Promise<void>;
  /** Ask the same scheduler the dashboard asks, for the organization the request names. */
  recommendSchedule(request: ScheduleRequest, actingDiscordUserId: string): Promise<ScheduleRecommendations>;
  /** Create a repeat, exactly as the dashboard's own form does. */
  createEventSeries(request: SeriesRequest, actingDiscordUserId: string): Promise<SeriesCreated>;
  /**
   * The members of an organization, which only a board member of it may read.
   * The role reconciliation asks for this as the board member the server
   * recorded when it was bound.
   */
  listRsoMembers(rsoId: number, actingDiscordUserId: string): Promise<RsoMember[]>;
  /** Whether the web platform answers. */
  health(): Promise<boolean>;
}

/**
 * The answers arrive as JSON in the web platform's spelling, which is snake
 * case, and the bot reads them in its own, which is camel case. Both the HTTP
 * implementation and the fake go through these two functions, so the fixtures
 * are exercised by the same code that reads the real answers.
 */
export function parseLinkSession(body: unknown): LinkSession {
  const raw = body as Record<string, unknown>;
  return {
    sessionId: String(raw.session_id ?? ''),
    address: String(raw.address ?? ''),
    expiresAt: String(raw.expires_at ?? ''),
  };
}

export function parseLinkedAccount(body: unknown): LinkedAccount {
  const raw = body as Record<string, unknown>;
  const memberships = Array.isArray(raw.memberships) ? raw.memberships : [];
  return {
    discordUserId: String(raw.discord_user_id ?? ''),
    netId: String(raw.net_id ?? ''),
    displayName: String(raw.display_name ?? ''),
    isGlobalAdmin: Boolean(raw.is_global_admin),
    linkedAt: String(raw.linked_at ?? ''),
    memberships: memberships.map(entry => {
      const row = entry as Record<string, unknown>;
      return {
        rsoId: Number(row.rso_id),
        rsoName: String(row.rso_name ?? ''),
        // The web platform stores roles capitalised, as Member, Editor, Board and
        // Admin. The bot speaks of them in lower case, so one place lowers them.
        role: String(row.role ?? 'member').toLowerCase() as MembershipRole,
      };
    }),
  };
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function count(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function parseRso(body: unknown): Rso {
  const raw = body as Record<string, unknown>;
  return {
    rsoId: Number(raw.rso_id),
    name: String(raw.name ?? ''),
    description: text(raw.description),
    logoColor: text(raw.logo_color),
  };
}

export function parseEvent(body: unknown): ViaEvent {
  const raw = body as Record<string, unknown>;
  return {
    eventId: Number(raw.event_id),
    rsoId: Number(raw.rso_id),
    rsoName: text(raw.rso_name),
    title: String(raw.title ?? ''),
    description: text(raw.description),
    startTime: String(raw.start_time ?? ''),
    endTime: String(raw.end_time ?? ''),
    isPrivate: Boolean(raw.is_private),
    cancelledAt: text(raw.cancelled_at),
    locationId: count(raw.location_id),
    building: text(raw.building),
    roomNumber: text(raw.room_number),
    locationText: text(raw.location_text),
    locationNote: text(raw.location_note),
    seriesId: count(raw.series_id),
    seriesFrequency: text(raw.series_frequency),
    seriesIntervalWeeks: count(raw.series_interval_weeks),
    seriesDaysOfWeek: text(raw.series_days_of_week),
    seriesEndsOn: text(raw.series_ends_on),
    interestCount: Number(raw.interest_count ?? 0),
  };
}

function parseEvents(value: unknown): ViaEvent[] {
  return Array.isArray(value) ? value.map(parseEvent) : [];
}

export function parseRsos(body: unknown): Rso[] {
  const raw = (body as Record<string, unknown> | null)?.rsos;
  return Array.isArray(raw) ? raw.map(parseRso) : [];
}

export function parseRsoWithEvents(body: unknown): RsoWithEvents {
  const raw = body as Record<string, unknown>;
  return { rso: parseRso(raw.rso), events: parseEvents(raw.events) };
}

export function parseEventPage(body: unknown): EventPage {
  const raw = body as Record<string, unknown>;
  return { events: parseEvents(raw.events), total: Number(raw.total ?? 0) };
}

/**
 * The query string a listing becomes, in the spelling the web platform's
 * reading router parses. Nothing the caller did not ask for is sent, so the
 * router's own defaults apply to everything else, and internal events are
 * asked for only when they were asked for.
 */
export function eventQueryParams(query: EventQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.rsoIds && query.rsoIds.length > 0) params.set('rso_ids', query.rsoIds.join(','));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  params.set('timeframe', query.timeframe ?? 'upcoming');
  if (query.includeInternal) params.set('include_internal', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  return params;
}

export function parseSeries(body: unknown): ViaSeries {
  const raw = body as Record<string, unknown>;
  return {
    seriesId: Number(raw.series_id),
    rsoId: Number(raw.rso_id),
    frequency: text(raw.frequency),
    intervalWeeks: count(raw.interval_weeks),
    daysOfWeek: text(raw.days_of_week),
    startsOn: text(raw.starts_on),
    endsOn: text(raw.ends_on),
    startOfDay: text(raw.start_of_day),
    durationMinutes: count(raw.duration_minutes),
  };
}

export function parseOutboxEntry(body: unknown): OutboxEntry {
  const raw = body as Record<string, unknown>;
  const payload = raw.payload;
  return {
    outboxId: Number(raw.outbox_id),
    kind: String(raw.kind ?? ''),
    subjectType: String(raw.subject_type ?? ''),
    subjectId: String(raw.subject_id ?? ''),
    rsoId: count(raw.rso_id),
    payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
    createdAt: String(raw.created_at ?? ''),
  };
}

/**
 * A whole number an outbox page carries, or null when what arrived is not one.
 *
 * The identifier of an entry is what the cursor is set to once that entry has
 * been handled, so an identifier that is not a whole number would leave the
 * cursor holding something no comparison is true of, and every entry after it
 * would be read for ever or never again.
 */
function outboxNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const read = Number(value);
  return Number.isSafeInteger(read) && read >= 0 ? read : null;
}

export function parseOutboxPage(body: unknown): OutboxPage {
  const raw = body as Record<string, unknown>;
  const given = Array.isArray(raw.entries) ? raw.entries : [];

  const entries: OutboxEntry[] = [];
  for (const one of given) {
    const outboxId = outboxNumber((one as Record<string, unknown>)?.outbox_id);
    if (outboxId === null) {
      // Loud, because this is the web platform sending a shape the contract
      // says it never sends, and quietly dropping it would leave nobody with
      // anything to look at.
      console.error(
        'the outbox sent an entry whose identifier is not a whole number, so it has been left out:',
        JSON.stringify((one as Record<string, unknown>)?.outbox_id ?? null),
      );
      continue;
    }
    entries.push(parseOutboxEntry(one));
  }

  return { entries, nextAfter: outboxNumber(raw.next_after) };
}

/**
 * The event an entry carries, or null when the entry is not about one. Every
 * event in the outbox is read through the same parser the reading endpoints
 * are, so an announcement and a card are built from the same object.
 */
export function outboxEvent(entry: OutboxEntry): ViaEvent | null {
  const raw = entry.payload.event;
  return raw && typeof raw === 'object' ? parseEvent(raw) : null;
}

/**
 * Why a change was made, when whoever made it said. A postponement from
 * Discord carries a reason and an ordinary edit does not, and the reason
 * belongs to the change rather than to the event, which is why it is on the
 * entry rather than in the event it carries.
 */
export function outboxReason(entry: OutboxEntry): string | null {
  const raw = entry.payload.reason;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** The fields an update says changed, which is empty for anything else. */
export function outboxChangedFields(entry: OutboxEntry): string[] {
  const raw = entry.payload.changed;
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** The series an entry carries, with the events it holds and the events it touched. */
export function outboxSeries(entry: OutboxEntry): SeriesChange | null {
  const raw = entry.payload.series;
  if (!raw || typeof raw !== 'object') return null;
  const ids = (value: unknown): number[] =>
    (Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []);
  const eventIds = ids(entry.payload.event_ids);
  const affected = ids(entry.payload.affected_event_ids);
  return {
    series: parseSeries(raw),
    eventIds,
    // An entry that names no affected events has touched the events it holds.
    affectedEventIds: affected.length > 0 ? affected : eventIds,
  };
}

export function parsePersonalCalendar(body: unknown): PersonalCalendar {
  const raw = body as Record<string, unknown>;
  return {
    address: String(raw.address ?? ''),
    rotatedAt: String(raw.rotated_at ?? ''),
  };
}

/**
 * What both calendar calls send. A set of null is sent as null rather than
 * left out, because the web platform has to tell "every organization" from
 * "the person named nothing" and only one of those is a calendar of the whole
 * of ECE.
 */
export function calendarRsosBody(rsoIds: readonly number[] | null): Record<string, unknown> {
  return { rso_ids: rsoIds === null ? null : [...rsoIds] };
}

export function parseInterestAnswer(body: unknown): InterestAnswer {
  const raw = body as Record<string, unknown>;
  return { ok: Boolean(raw.ok), interestCount: Number(raw.interest_count ?? 0) };
}

/**
 * What the interest call sends. A linked person is named by the acting
 * header, so the body says only what they want. Somebody who is not linked is
 * named in the body by their Discord identifier, which the web platform
 * hashes with its own salt before recording it.
 */
export function interestBody(interest: InterestSignal): Record<string, unknown> {
  const body: Record<string, unknown> = { interested: interest.interested };
  if (!interest.actingDiscordUserId && interest.discordUserId) {
    body.discord_user_id = interest.discordUserId;
  }
  return body;
}

/**
 * What the feedback call sends. The person is named by the acting header, as
 * every acting endpoint names them, so the body carries the score and the
 * comment and nothing about who left them. A comment nobody wrote is left out
 * rather than sent as an empty string.
 */
export function feedbackBody(feedback: EventFeedback): Record<string, unknown> {
  const body: Record<string, unknown> = { rating: feedback.rating };
  if (feedback.comment) body.comment = feedback.comment;
  return body;
}

/**
 * The campus answers, read the same way the event answers are: one parser per
 * shape, shared by the HTTP client and the fake, so a fixture that stops
 * matching the web platform breaks both.
 */
export function parseMidterm(body: unknown): Midterm {
  const raw = body as Record<string, unknown>;
  return {
    midtermId: Number(raw.midterm_id),
    courseCode: String(raw.course_code ?? ''),
    courseTitle: text(raw.course_title),
    title: text(raw.title),
    startTime: String(raw.start_time ?? ''),
    endTime: String(raw.end_time ?? ''),
    // The web platform stores the status capitalised, as Confirmed, Pending
    // and Cancelled, and the bot speaks of it in lower case, as it does with
    // the membership roles.
    status: String(raw.status ?? 'pending').toLowerCase() as MidtermStatus,
    locationText: text(raw.location_text),
    building: text(raw.building),
    roomNumber: text(raw.room_number),
  };
}

export function parseMidterms(body: unknown): Midterm[] {
  const raw = (body as Record<string, unknown> | null)?.midterms;
  return Array.isArray(raw) ? raw.map(parseMidterm) : [];
}

export function parseCourseSection(body: unknown): CourseSection {
  const raw = body as Record<string, unknown>;
  return {
    sectionId: Number(raw.section_id),
    dayOfWeek: text(raw.day_of_week),
    startTime: text(raw.start_time),
    endTime: text(raw.end_time),
    semester: text(raw.semester),
    sectionType: text(raw.section_type),
    building: text(raw.building),
    roomNumber: text(raw.room_number),
  };
}

export function parseCourse(body: unknown): Course {
  const raw = body as Record<string, unknown>;
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  return {
    courseCode: String(raw.course_code ?? ''),
    title: text(raw.title),
    sections: sections.map(parseCourseSection),
  };
}

export function parseCourses(body: unknown): Course[] {
  const raw = (body as Record<string, unknown> | null)?.courses;
  return Array.isArray(raw) ? raw.map(parseCourse) : [];
}

export function parseLocation(body: unknown): CampusLocation {
  const raw = body as Record<string, unknown>;
  return {
    locationId: Number(raw.location_id),
    building: String(raw.building ?? ''),
    roomNumber: text(raw.room_number),
    maxCapacity: count(raw.max_capacity),
    // The column is a flag stored as a number, which reads as a yes or a no.
    hasAvEquipment: Boolean(raw.has_av_equipment),
  };
}

export function parseLocations(body: unknown): CampusLocation[] {
  const raw = (body as Record<string, unknown> | null)?.locations;
  return Array.isArray(raw) ? raw.map(parseLocation) : [];
}

export function parseFreeRooms(body: unknown): FreeRooms {
  const raw = body as Record<string, unknown>;
  return {
    building: String(raw.building ?? ''),
    from: String(raw.from ?? ''),
    to: String(raw.to ?? ''),
    locations: parseLocations(raw),
  };
}

export function parseBuilding(body: unknown): Building {
  const raw = (body as Record<string, unknown> | null)?.building as Record<string, unknown>;
  return {
    code: String(raw?.code ?? ''),
    name: String(raw?.name ?? ''),
    address: text(raw?.address),
  };
}

/**
 * The query string a midterm listing becomes. Nothing the caller did not ask
 * for is sent, so the reading router's own defaults apply to the rest.
 */
export function midtermQueryParams(query: MidtermQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.course) params.set('course', query.course);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  return params;
}

/**
 * The midterm an entry carries, or null when the entry is not about one. The
 * three midterm kinds all carry the exam as it stands after the change, so a
 * notice can be written without a second call.
 */
export function outboxMidterm(entry: OutboxEntry): Midterm | null {
  const raw = entry.payload.midterm;
  return raw && typeof raw === 'object' ? parseMidterm(raw) : null;
}

/**
 * The acting answers.
 *
 * Postponing and patching answer with the event as it now stands, in the same
 * shape every reading endpoint uses, so a card drawn after a change is drawn
 * by the same code as a card drawn before it.
 */
export function parseActingEvent(body: unknown): ViaEvent | null {
  const raw = (body as Record<string, unknown> | null)?.event;
  return raw && typeof raw === 'object' ? parseEvent(raw) : null;
}

/** The body a postponement sends, with the reason only when there is one. */
export function postponementBody(postponement: Postponement): Record<string, unknown> {
  const body: Record<string, unknown> = {
    start_time: postponement.startTime,
    end_time: postponement.endTime,
  };
  const reason = (postponement.reason ?? '').trim();
  if (reason) body.reason = reason;
  return body;
}

/**
 * The body a change sends. A field the caller did not name is left out, which
 * is how the request says it means to leave that field alone, and a field
 * named as null is sent as null, which is how it says to clear it.
 */
export function eventChangesBody(changes: EventChanges): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ('description' in changes) body.description = changes.description ?? null;
  if ('isPrivate' in changes) body.is_private = Boolean(changes.isPrivate);
  if ('locationNote' in changes) body.location_note = changes.locationNote ?? null;
  return body;
}

export function parseRsoMember(body: unknown): RsoMember {
  const raw = body as Record<string, unknown>;
  return {
    netId: String(raw.net_id ?? ''),
    fullName: text(raw.full_name),
    // The web platform stores roles capitalised, as it does everywhere else,
    // and the bot speaks of them in lower case.
    role: String(raw.role ?? 'member').toLowerCase() as MembershipRole,
  };
}

export function parseRsoMembers(body: unknown): RsoMember[] {
  const raw = (body as Record<string, unknown> | null)?.members;
  return Array.isArray(raw) ? raw.map(parseRsoMember) : [];
}

/**
 * What the scheduler asks for, in the spelling its route reads.
 *
 * The window of the day is sent as a required constraint, because a board that
 * said its meetings run in the evening does not want a recommendation at nine
 * in the morning with a few points taken off.
 */
export function scheduleRequestBody(request: ScheduleRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    rso_id: request.rsoId,
    durationMinutes: request.durationMinutes,
    dateRange: { start: request.dateRange.start, end: request.dateRange.end },
  };
  if (request.timeConstraint) {
    body.timeConstraint = {
      startHour: request.timeConstraint.startHour,
      endHour: request.timeConstraint.endHour,
      tier: 'required',
    };
  }
  if (request.recurrence) {
    const recurrence: Record<string, unknown> = {
      intervalWeeks: request.recurrence.intervalWeeks,
      daysOfWeek: [...request.recurrence.daysOfWeek],
    };
    if (request.recurrence.until) recurrence.until = request.recurrence.until;
    body.recurrence = recurrence;
  }
  return body;
}

/**
 * One candidate, read out of the scheduler's own answer. The room sits under
 * a location object and the repeat under a recurrence object, and both are
 * flattened here so that everything a card shows is one field.
 */
/** A time the web platform sent with its offset, as the campus wall clock it names. */
function wallClockOf(value: unknown): string {
  const instant = toInstant(String(value ?? ''));
  return instant ? campusStamp(instant) : '';
}

export function parseScheduleCandidate(body: unknown): ScheduleCandidate {
  const raw = body as Record<string, unknown>;
  const location = (raw.location ?? {}) as Record<string, unknown>;
  const recurrence = (raw.recurrence ?? null) as Record<string, unknown> | null;
  const insights = Array.isArray(raw.insights) ? raw.insights : [];
  const dates = (value: unknown): string[] =>
    (Array.isArray(value) ? value.map(String) : []);

  return {
    // The web platform sends every time with the campus offset on it. A
    // candidate goes back to the web platform as the wall clock the series
    // form posts, so it is read as wall clock here, once.
    startTime: wallClockOf(raw.start),
    endTime: wallClockOf(raw.end),
    locationId: count(location.location_id),
    building: text(location.building),
    roomNumber: text(location.room_number),
    maxCapacity: count(location.max_capacity),
    score: Number(raw.score ?? 0),
    reasons: insights
      .map(entry => String((entry as Record<string, unknown>)?.text ?? ''))
      .filter(Boolean),
    intervalWeeks: recurrence ? count(recurrence.interval_weeks) : null,
    daysOfWeek: recurrence ? dates(recurrence.days_of_week) : [],
    weeksTotal: recurrence ? count(recurrence.weeks_total) : null,
    weeksClear: recurrence ? count(recurrence.weeks_clear) : null,
    conflicts: recurrence ? dates(recurrence.conflicts) : [],
    until: recurrence ? text(recurrence.until) : null,
  };
}

export function parseScheduleRecommendations(body: unknown): ScheduleRecommendations {
  const raw = body as Record<string, unknown>;
  const candidates = (value: unknown): ScheduleCandidate[] =>
    (Array.isArray(value) ? value.map(parseScheduleCandidate) : []);
  return {
    curatedPicks: candidates(raw.curatedPicks),
    allOptions: candidates(raw.allOptions),
  };
}

/**
 * What creating a repeat sends. The recurrence keys are the ones the series
 * planner reads, which are not the ones the scheduler route reads, so the two
 * are written out separately rather than shared and hoped over.
 */
export function seriesRequestBody(request: SeriesRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    rso_id: request.rsoId,
    title: request.title,
    start_time: request.startTime,
    end_time: request.endTime,
  };
  if (request.description !== undefined) body.description = request.description;
  if (request.isPrivate !== undefined) body.is_private = request.isPrivate;
  if (request.locationId !== undefined && request.locationId !== null) body.location_id = request.locationId;
  if (request.locationText) body.location_text = request.locationText;

  const recurrence: Record<string, unknown> = {
    interval_weeks: request.recurrence.intervalWeeks,
    days_of_week: [...request.recurrence.daysOfWeek],
  };
  if (request.recurrence.startsOn) recurrence.starts_on = request.recurrence.startsOn;
  if (request.recurrence.endsOn) recurrence.ends_on = request.recurrence.endsOn;
  body.recurrence = recurrence;
  return body;
}

export function parseSeriesCreated(body: unknown): SeriesCreated {
  const raw = body as Record<string, unknown>;
  const eventIds = Array.isArray(raw.event_ids) ? raw.event_ids.map(Number) : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.map(String) : [];
  return {
    seriesId: Number(raw.series_id),
    eventIds,
    created: Number(raw.created ?? eventIds.length),
    skipped,
  };
}
