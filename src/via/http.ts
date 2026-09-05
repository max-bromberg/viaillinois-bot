import { randomUUID } from 'node:crypto';
import {
  ViaError, ViaBusyError, calendarRsosBody, eventChangesBody, eventQueryParams, feedbackBody,
  interestBody, midtermQueryParams, parseActingEvent, parseBuilding, parseCourses, parseEvent,
  parseEventPage, parseFreeRooms, parseInterestAnswer, parseLinkSession, parseLinkedAccount,
  parseLocations, parseMidterms, parseOutboxPage, parsePersonalCalendar, parseRsoMembers, parseRsoWithEvents,
  parseRsos, parseScheduleRecommendations, parseSeriesCreated, postponementBody,
  scheduleRequestBody, seriesRequestBody,
  type ViaClient, type ViaErrorCode, type Building, type CampusLocation, type Course,
  type EventChanges, type EventFeedback, type EventPage, type EventQuery, type FreeRooms,
  type FreeRoomQuery, type InterestAnswer, type InterestSignal, type LinkSession,
  type LinkedAccount, type Midterm, type MidtermQuery, type OutboxPage, type OutboxQuery,
  type PersonalCalendar, type Postponement,
  type Rso, type RsoMember, type RsoWithEvents, type ScheduleRecommendations, type ScheduleRequest,
  type SeriesCreated, type SeriesRequest, type ViaEvent,
} from './client.ts';

/**
 * The web platform client over HTTP.
 *
 * It attaches the service token, the acting Discord user identifier when
 * there is one, and a request identifier, and it understands the two refusal
 * shapes the web platform answers with. A busy answer names a wait, so the
 * client waits exactly that long and tries once more, and a second busy
 * answer becomes a ViaBusyError that the caller turns into a sentence naming
 * the wait. Everything else with an error code becomes a ViaError, and a
 * failure to reach the web platform at all becomes one too, so a caller has
 * one kind of failure to handle rather than three.
 *
 * The client never sets a forwarded address header. The web platform refuses
 * the internal prefix when one is present, because a request carrying one
 * arrived through the reverse proxy and therefore from the internet.
 */

/** Where the internal service API is mounted on the web platform. */
export const INTERNAL_PREFIX = '/internal/v1';

/** The header that names the person the bot is acting for. */
export const ACTING_HEADER = 'X-Via-Acting-Discord-User';

/** The header that ties a bot request to the web platform's log of it. */
export const REQUEST_ID_HEADER = 'X-Via-Request-Id';

/** What the bot waits when a busy answer names no wait of its own. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * The longest the bot waits before trying a busy request again, and the
 * longest wait it will name to a person.
 *
 * The wait comes from the web platform, which is right: it knows how loaded it
 * is. What it does not know is that the bot is often holding a Discord
 * interaction open while it waits, and Discord closes that after fifteen
 * minutes. A wait of an hour would therefore be a command that never answers,
 * so the wait is taken as far as a minute and no further. The bot still does
 * not retry inside the wait, which is what section 9 of the design asks for.
 */
export const MAX_RETRY_AFTER_SECONDS = 60;

/** How long a single request may take before the bot gives up on it. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type ViaMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ViaRequest {
  method: ViaMethod;
  /** The path under the internal prefix, beginning with a slash. */
  path: string;
  /** A JSON body, for the methods that carry one. */
  body?: unknown;
  /** The Discord user the bot is acting for, when it is acting for one. */
  actingDiscordUserId?: string;
}

export interface ViaHttpOptions {
  /** The address of the web platform on the private container network. */
  baseUrl: string;
  /** BOT_SERVICE_TOKEN, which both containers read from the stack. */
  serviceToken: string;
  /** Injected so that tests answer without a web platform. */
  fetchImpl?: typeof fetch;
  /** Injected so that tests observe the wait without serving it. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected so that tests can assert on a fixed request identifier. */
  newRequestId?: () => string;
  timeoutMs?: number;
}

/**
 * The HTTP client. Beside the methods of the interface it exposes the two
 * request seams they are built on, which is where the endpoints of the later
 * increments are added.
 */
export interface ViaHttpClient extends ViaClient {
  request<T>(request: ViaRequest): Promise<T>;
  /** The answer as text, for the calendar endpoint, which does not send JSON. */
  requestText(request: ViaRequest): Promise<string>;
}

interface Answer {
  status: number;
  body: unknown;
  /** The answer as it arrived, for the one endpoint that is not JSON. */
  text: string;
  retryAfterSeconds: number | null;
  requestId: string;
}

const KNOWN_CODES = new Set<string>([
  'unauthorized', 'not_linked', 'forbidden', 'not_found', 'invalid', 'busy', 'conflict', 'unreachable',
]);

function codeOf(status: number, body: unknown): ViaErrorCode {
  const raw = (body as Record<string, unknown> | null)?.code;
  if (typeof raw === 'string' && KNOWN_CODES.has(raw)) return raw as ViaErrorCode;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 503) return 'busy';
  return 'invalid';
}

function messageOf(body: unknown, fallback: string): string {
  const raw = (body as Record<string, unknown> | null)?.error;
  return typeof raw === 'string' && raw.trim() ? raw : fallback;
}

/** A busy answer names its wait in the body, and in a header for anything that reads headers. */
function retryAfterOf(headerValue: string | null, body: unknown): number {
  const named = namedRetryAfter(headerValue, body);
  return Math.min(named, MAX_RETRY_AFTER_SECONDS);
}

function namedRetryAfter(headerValue: string | null, body: unknown): number {
  const fromBody = (body as Record<string, unknown> | null)?.retry_after_seconds;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const fromHeader = Number(headerValue);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.ceil(fromHeader);
  return DEFAULT_RETRY_AFTER_SECONDS;
}

export function createViaHttpClient(options: ViaHttpOptions): ViaHttpClient {
  const {
    baseUrl,
    serviceToken,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    newRequestId = () => randomUUID(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const address = (path: string) => `${baseUrl.replace(/\/+$/, '')}${path}`;

  async function send(request: ViaRequest, requestId: string): Promise<Answer> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${serviceToken}`,
      Accept: 'application/json',
      [REQUEST_ID_HEADER]: requestId,
    };
    if (request.actingDiscordUserId) headers[ACTING_HEADER] = request.actingDiscordUserId;
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(address(`${INTERNAL_PREFIX}${request.path}`), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ViaError('The VIA web platform did not answer.', 0, 'unreachable', requestId);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return {
      status: response.status,
      body,
      text,
      retryAfterSeconds: response.status === 503 ? retryAfterOf(response.headers.get('Retry-After'), body) : null,
      requestId,
    };
  }

  /**
   * One attempt, one wait, one retry. The web platform places the internal
   * prefix in the last tier load shedding refuses, so a busy answer means the
   * web platform is in real trouble and a second wait would only add to it.
   */
  async function attempt(request: ViaRequest): Promise<Answer> {
    const requestId = newRequestId();
    const first = await send(request, requestId);
    if (first.status !== 503) return first;

    await sleep(first.retryAfterSeconds! * 1000);
    const second = await send(request, requestId);
    if (second.status !== 503) return second;

    throw new ViaBusyError(
      messageOf(second.body, 'VIA is busy right now. Please try again in a moment.'),
      second.retryAfterSeconds!,
      requestId,
    );
  }

  /** An answer that is not a success becomes the typed error for its code. */
  function refuse(answer: Answer): never {
    throw new ViaError(
      messageOf(answer.body, 'The VIA web platform refused the request.'),
      answer.status,
      codeOf(answer.status, answer.body),
      answer.requestId,
    );
  }

  async function request<T>(req: ViaRequest): Promise<T> {
    const answer = await attempt(req);
    if (answer.status >= 200 && answer.status < 300) return answer.body as T;
    return refuse(answer);
  }

  async function requestText(req: ViaRequest): Promise<string> {
    const answer = await attempt(req);
    if (answer.status >= 200 && answer.status < 300) return answer.text;
    return refuse(answer);
  }

  /** An answer of 404 that means absence rather than failure, for the lookups that allow it. */
  async function requestOrAbsent<T>(req: ViaRequest): Promise<T | null> {
    const answer = await attempt(req);
    if (answer.status === 404) return null;
    if (answer.status >= 200 && answer.status < 300) return answer.body as T;
    return refuse(answer);
  }

  return {
    request,
    requestText,

    async openLinkSession(discordUserId: string): Promise<LinkSession> {
      const body = await request<unknown>({
        method: 'POST',
        path: '/links/sessions',
        body: { discord_user_id: discordUserId },
      });
      return parseLinkSession(body);
    },

    async getLink(discordUserId: string): Promise<LinkedAccount | null> {
      const body = await requestOrAbsent<unknown>({
        method: 'GET',
        path: `/links/${encodeURIComponent(discordUserId)}`,
      });
      return body === null ? null : parseLinkedAccount(body);
    },

    async unlink(discordUserId: string): Promise<boolean> {
      // A successful delete carries no body, so the answer to "was there a
      // link" is the status and not the content.
      const answer = await attempt({
        method: 'DELETE',
        path: `/links/${encodeURIComponent(discordUserId)}`,
      });
      if (answer.status === 404) return false;
      if (answer.status >= 200 && answer.status < 300) return true;
      return refuse(answer);
    },

    async listRsos(): Promise<Rso[]> {
      return parseRsos(await request<unknown>({ method: 'GET', path: '/rsos' }));
    },

    async getRso(rsoId: number, actingDiscordUserId?: string): Promise<RsoWithEvents | null> {
      const body = await requestOrAbsent<unknown>({
        method: 'GET',
        path: `/rsos/${encodeURIComponent(String(rsoId))}`,
        actingDiscordUserId,
      });
      return body === null ? null : parseRsoWithEvents(body);
    },

    async listEvents(query: EventQuery): Promise<EventPage> {
      const body = await request<unknown>({
        method: 'GET',
        path: `/events?${eventQueryParams(query).toString()}`,
        actingDiscordUserId: query.actingDiscordUserId,
      });
      return parseEventPage(body);
    },

    /**
     * An event a person may not see is answered with the same 404 as an event
     * that does not exist, which is what the reading router does deliberately,
     * so there is one absent answer here rather than two.
     */
    async getEvent(eventId: number, actingDiscordUserId?: string): Promise<ViaEvent | null> {
      const body = await requestOrAbsent<{ event?: unknown }>({
        method: 'GET',
        path: `/events/${encodeURIComponent(String(eventId))}`,
        actingDiscordUserId,
      });
      return body === null ? null : parseEvent(body.event);
    },

    async getEventCalendar(eventId: number): Promise<string> {
      return requestText({
        method: 'GET',
        path: `/events/${encodeURIComponent(String(eventId))}/calendar`,
      });
    },

    /**
     * Binding is the one setup step the web platform decides. The bot sends
     * the organization and the person, and reads the refusal rather than
     * working out for itself who sits on which board.
     */
    async confirmBinding(rsoId: number, actingDiscordUserId: string): Promise<void> {
      await request<unknown>({
        method: 'POST',
        path: '/guilds/bindings/confirm',
        body: { rso_id: rsoId },
        actingDiscordUserId,
      });
    },

    /**
     * The outbox is the web platform speaking to the bot rather than to a
     * person, so it carries no acting header. The cursor is the bot's own, and
     * the web platform keeps nothing about what has been read.
     */
    async readOutbox(query: OutboxQuery): Promise<OutboxPage> {
      const params = new URLSearchParams({ after: String(query.after) });
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      return parseOutboxPage(await request<unknown>({
        method: 'GET',
        path: `/outbox?${params.toString()}`,
      }));
    },

    /**
     * Interest is what replaces the RSVPs the web platform removed. A linked
     * person is named by the acting header and recorded by NetID, and anybody
     * else is named by their Discord identifier, which the web platform
     * records as a salted hash so that the count is honest and nobody can
     * reverse it.
     */
    async setInterest(eventId: number, interest: InterestSignal): Promise<InterestAnswer> {
      return parseInterestAnswer(await request<unknown>({
        method: 'PUT',
        path: `/events/${encodeURIComponent(String(eventId))}/interest`,
        body: interestBody(interest),
        actingDiscordUserId: interest.actingDiscordUserId,
      }));
    },

    /**
     * The calendar is the person's own, so it is asked for as them and the
     * address comes back with a token in it. Asking again rotates the token,
     * which is how somebody who shared the address by accident takes it back.
     */
    async createPersonalCalendar(
      rsoIds: readonly number[] | null,
      actingDiscordUserId: string,
    ): Promise<PersonalCalendar> {
      return parsePersonalCalendar(await request<unknown>({
        method: 'POST',
        path: '/calendars/personal',
        body: calendarRsosBody(rsoIds),
        actingDiscordUserId,
      }));
    },

    async updatePersonalCalendarRsos(
      rsoIds: readonly number[] | null,
      actingDiscordUserId: string,
    ): Promise<void> {
      await request<unknown>({
        method: 'PUT',
        path: '/calendars/personal/rsos',
        body: calendarRsosBody(rsoIds),
        actingDiscordUserId,
      });
    },

    /**
     * The campus lookups. None of them carries an acting person, because none
     * of them depends on who is asking: an exam schedule and a building code
     * are the same for everybody.
     */
    async listMidterms(query: MidtermQuery = {}): Promise<Midterm[]> {
      const params = midtermQueryParams(query).toString();
      return parseMidterms(await request<unknown>({
        method: 'GET',
        path: params ? `/midterms?${params}` : '/midterms',
      }));
    },

    async searchCourses(term: string, options: { sections?: boolean } = {}): Promise<Course[]> {
      const params = new URLSearchParams({ query: term });
      // The sections are a second query on the web platform, so they are asked
      // for only where they are shown, which is the course lookup rather than
      // the autocomplete behind it.
      if (options.sections) params.set('sections', 'true');
      return parseCourses(await request<unknown>({
        method: 'GET',
        path: `/courses?${params.toString()}`,
      }));
    },

    async searchLocations(term: string): Promise<CampusLocation[]> {
      const params = new URLSearchParams({ query: term });
      return parseLocations(await request<unknown>({
        method: 'GET',
        path: `/locations?${params.toString()}`,
      }));
    },

    async freeRooms(query: FreeRoomQuery): Promise<FreeRooms> {
      const params = new URLSearchParams({
        building: query.building,
        from: query.from,
        to: query.to,
      });
      return parseFreeRooms(await request<unknown>({
        method: 'GET',
        path: `/locations/free?${params.toString()}`,
      }));
    },

    async getBuilding(code: string): Promise<Building | null> {
      const body = await requestOrAbsent<unknown>({
        method: 'GET',
        path: `/buildings/${encodeURIComponent(code)}`,
      });
      return body === null ? null : parseBuilding(body);
    },

    /**
     * The acting endpoints.
     *
     * Each of these runs the controller the dashboard's own route runs, so a
     * board member who postpones a meeting from Discord and one who postpones
     * it from the website get the same checks and the same refusals. Nothing
     * here decides anything: the acting header names the Discord account, and
     * the web platform answers.
     */
    async postponeEvent(
      eventId: number,
      postponement: Postponement,
      actingDiscordUserId: string,
    ): Promise<ViaEvent | null> {
      return parseActingEvent(await request<unknown>({
        method: 'POST',
        path: `/events/${encodeURIComponent(String(eventId))}/postpone`,
        body: postponementBody(postponement),
        actingDiscordUserId,
      }));
    },

    async cancelEvent(eventId: number, actingDiscordUserId: string): Promise<string | null> {
      const body = await request<Record<string, unknown>>({
        method: 'POST',
        path: `/events/${encodeURIComponent(String(eventId))}/cancel`,
        body: {},
        actingDiscordUserId,
      });
      const cancelledAt = body?.cancelled_at;
      return cancelledAt === null || cancelledAt === undefined ? null : String(cancelledAt);
    },

    async patchEvent(
      eventId: number,
      changes: EventChanges,
      actingDiscordUserId: string,
    ): Promise<ViaEvent | null> {
      return parseActingEvent(await request<unknown>({
        method: 'PATCH',
        path: `/events/${encodeURIComponent(String(eventId))}`,
        body: eventChangesBody(changes),
        actingDiscordUserId,
      }));
    },

    /**
     * The score and the comment go to the web platform as the acting person,
     * which is how it records them against a NetID and how it refuses somebody
     * whose account it no longer knows.
     */
    async recordFeedback(
      eventId: number,
      feedback: EventFeedback,
      actingDiscordUserId: string,
    ): Promise<void> {
      await request<unknown>({
        method: 'POST',
        path: `/events/${encodeURIComponent(String(eventId))}/feedback`,
        body: feedbackBody(feedback),
        actingDiscordUserId,
      });
    },

    async recommendSchedule(
      scheduleRequest: ScheduleRequest,
      actingDiscordUserId: string,
    ): Promise<ScheduleRecommendations> {
      return parseScheduleRecommendations(await request<unknown>({
        method: 'POST',
        path: '/scheduler/recommend',
        body: scheduleRequestBody(scheduleRequest),
        actingDiscordUserId,
      }));
    },

    async createEventSeries(
      seriesRequest: SeriesRequest,
      actingDiscordUserId: string,
    ): Promise<SeriesCreated> {
      return parseSeriesCreated(await request<unknown>({
        method: 'POST',
        path: '/events/series',
        body: seriesRequestBody(seriesRequest),
        actingDiscordUserId,
      }));
    },

    /**
     * The members of an organization, which the reading router lets only a
     * board member of it read. The bot reads it for role reconciliation and
     * writes down none of what comes back beyond the Discord accounts it can
     * already name.
     */
    async listRsoMembers(rsoId: number, actingDiscordUserId: string): Promise<RsoMember[]> {
      return parseRsoMembers(await request<unknown>({
        method: 'GET',
        path: `/rsos/${encodeURIComponent(String(rsoId))}/members`,
        actingDiscordUserId,
      }));
    },

    /**
     * The web platform serves one port, and its health endpoint is the one
     * path on it that is safe to poll continuously. The bot's own health
     * endpoint reports the answer, so a web platform that is down shows as a
     * bot that is not ready rather than as commands that fail one by one.
     */
    async health(): Promise<boolean> {
      try {
        const response = await fetchImpl(address('/health'), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${serviceToken}`,
            Accept: 'application/json',
            [REQUEST_ID_HEADER]: newRequestId(),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
