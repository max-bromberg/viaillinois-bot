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
 * The private calendar address a person subscribes to from their own calendar
 * application, and when its token was last rotated. The token lives in the
 * address, so asking for the calendar again is what rotating it means, and the
 * bot never stores either one.
 */
export interface PersonalCalendar {
  address: string;
  rotatedAt: string;
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

export function parseOutboxPage(body: unknown): OutboxPage {
  const raw = body as Record<string, unknown>;
  const entries = Array.isArray(raw.entries) ? raw.entries.map(parseOutboxEntry) : [];
  const next = raw.next_after;
  return { entries, nextAfter: next === null || next === undefined ? null : Number(next) };
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
