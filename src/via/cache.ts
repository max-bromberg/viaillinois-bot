import { eventQueryParams, type EventPage, type EventQuery, type Rso, type ViaClient } from './client.ts';

/**
 * The hot read cache.
 *
 * Section 7 of the design names two reads as hot: the organization list, which
 * every autocomplete needs, and the events coming up for an organization,
 * which every listing needs. Both are cached for a minute, and the cache is
 * dropped for an organization when an outbox entry touches it, so a change
 * made on the website shows in Discord within seconds rather than within a
 * minute.
 *
 * A listing that asks for internal events is never cached. The web platform
 * answers those from the acting person's own memberships, so one person's
 * answer is not another person's answer, and an entry keyed by the query alone
 * would show one student an organization's internal events because a member of
 * it asked first. Everything the cache does hold is the same for everybody,
 * which is what makes holding it safe.
 *
 * Answers are copied on the way in and on the way out, so a caller that edits
 * what it was given cannot change what the next caller is given.
 */

/** How long a hot read is held, which the design puts at a minute. */
export const HOT_READ_TTL_MS = 60_000;

export interface HotReadCacheOptions {
  /** Injected so that tests move time rather than wait for it. */
  now?: () => Date;
  ttlMs?: number;
}

export interface CachedViaClient extends ViaClient {
  /** Drop everything held for an organization, which the outbox consumer calls. */
  invalidateRso(rsoId: number): void;
  /** Drop everything, for a restart or a test. */
  invalidateAll(): void;
}

interface Entry<T> {
  value: T;
  /** The instant the entry stops being served, in milliseconds. */
  expiresAt: number;
}

/** The organizations a listing concerns, or null when it concerns all of them. */
function rsosOf(query: EventQuery): number[] | null {
  return query.rsoIds && query.rsoIds.length > 0 ? [...query.rsoIds] : null;
}

/**
 * What makes one listing a different listing. The acting person is left out
 * deliberately, because a listing that does not ask for internal events is
 * answered the same way for everybody, and a listing that does is not cached.
 */
function listingKey(query: EventQuery): string {
  return eventQueryParams(query).toString();
}

export function withHotReadCache(inner: ViaClient, options: HotReadCacheOptions = {}): CachedViaClient {
  const { now = () => new Date(), ttlMs = HOT_READ_TTL_MS } = options;

  let rsoList: Entry<Rso[]> | null = null;
  const listings = new Map<string, { entry: Entry<EventPage>; rsoIds: number[] | null }>();

  const fresh = (entry: Entry<unknown>) => entry.expiresAt > now().getTime();
  const until = () => now().getTime() + ttlMs;

  function copyPage(page: EventPage): EventPage {
    return { total: page.total, events: page.events.map(event => ({ ...event })) };
  }

  return {
    ...inner,

    invalidateRso(rsoId: number): void {
      rsoList = null;
      for (const [key, held] of listings) {
        // A listing across every organization is a listing about this one too.
        if (held.rsoIds === null || held.rsoIds.includes(rsoId)) listings.delete(key);
      }
    },

    invalidateAll(): void {
      rsoList = null;
      listings.clear();
    },

    async listRsos(): Promise<Rso[]> {
      if (rsoList && fresh(rsoList)) return rsoList.value.map(rso => ({ ...rso }));
      const value = await inner.listRsos();
      rsoList = { value: value.map(rso => ({ ...rso })), expiresAt: until() };
      return value.map(rso => ({ ...rso }));
    },

    async listEvents(query: EventQuery): Promise<EventPage> {
      if (query.includeInternal) return inner.listEvents(query);

      const key = listingKey(query);
      const held = listings.get(key);
      if (held && fresh(held.entry)) return copyPage(held.entry.value);

      const value = await inner.listEvents(query);
      listings.set(key, {
        entry: { value: copyPage(value), expiresAt: until() },
        rsoIds: rsosOf(query),
      });
      return copyPage(value);
    },
  };
}
