import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from '../db/schema.ts';
import { rateWindows } from '../db/schema.ts';
import { DEFAULT_RATE_LIMITS, type RateLimitConfig } from '../config.ts';

/**
 * The bot's own rate limits.
 *
 * Three limits apply, from section 9 of the design: a sliding window of
 * commands per hour for a Discord user, tighter when they are not linked than
 * when they are, because a linked person is accountable through a NetID, and
 * a ceiling per server, so that a script in one server cannot starve the
 * others. All three answer with a sentence and a wait rather than with
 * silence.
 *
 * The window is kept as one row per subject and minute, and the count is the
 * sum of the last sixty of those rows. That is a sliding window with a
 * minute of granularity, which costs at most sixty small rows per subject and
 * needs no background work to expire anything. The sweep exists to remove
 * rows nobody will read again, not to make the arithmetic correct.
 *
 * Bucket_start holds UTC rather than campus wall clock, which is the one
 * column in this database that does. A window is a duration, and a duration
 * cannot be measured on a clock that repeats an hour in November and skips
 * one in March. Nobody reads this column, so nothing is lost by keeping it on
 * a clock that only ever moves forward.
 */

export type BotDatabase = MySql2Database<typeof schema>;

/** Which limit applies: a person who has not linked, one who has, or a server. */
export type RateTier = 'unlinked' | 'linked' | 'guild';

/**
 * The limits themselves are read from the environment in src/config.ts,
 * which is where the defaults live too, so that the deployment document has
 * one place to describe and this module has none of its own.
 */
export type RateLimits = RateLimitConfig;

export { DEFAULT_RATE_LIMITS };

/** How long the window is, in minutes. */
export const DEFAULT_WINDOW_MINUTES = 60;

/**
 * How long a bucket is kept after it stops counting. Twice the window is
 * enough for anybody looking at recent behaviour, and the design's ninety day
 * ceiling is the outer bound rather than a reason to keep rows that no
 * question is asked of.
 */
export const DEFAULT_KEEP_MINUTES = 120;

export interface RateDecision {
  allowed: boolean;
  /** How many commands the subject had already used in the window. */
  used: number;
  /** The limit that applied. */
  limit: number;
  /** How long to wait, in seconds, and zero when the command was allowed. */
  retryAfterSeconds: number;
}

export interface RateWindows {
  /** Count one command against a subject, and say whether it is allowed. */
  consume(subject: string, tier: RateTier): Promise<RateDecision>;
  /** Remove buckets nothing will read again, and say how many went. */
  sweep(): Promise<number>;
}

export interface RateWindowOptions {
  db: BotDatabase;
  limits?: RateLimits;
  now?: () => Date;
  windowMinutes?: number;
  keepMinutes?: number;
}

/** A Discord user, as the subject column spells one. */
export function userSubject(discordUserId: string): string {
  return `user:${discordUserId}`;
}

/** A server, as the subject column spells one. */
export function guildSubject(guildId: string): string {
  return `guild:${guildId}`;
}

/** The minute an instant falls in, as the column stores it. */
function bucketOf(instant: Date): string {
  const minute = new Date(Math.floor(instant.getTime() / 60_000) * 60_000);
  return minute.toISOString().slice(0, 19).replace('T', ' ');
}

/** The instant a stored bucket began. */
function instantOf(bucket: string): number {
  return Date.parse(`${bucket.replace(' ', 'T')}Z`);
}

function limitFor(limits: RateLimits, tier: RateTier): number {
  if (tier === 'unlinked') return limits.unlinkedPerHour;
  if (tier === 'linked') return limits.linkedPerHour;
  return limits.guildPerHour;
}

export function createRateWindows(options: RateWindowOptions): RateWindows {
  const {
    db,
    limits = DEFAULT_RATE_LIMITS,
    now = () => new Date(),
    windowMinutes = DEFAULT_WINDOW_MINUTES,
    keepMinutes = DEFAULT_KEEP_MINUTES,
  } = options;

  return {
    async consume(subject: string, tier: RateTier): Promise<RateDecision> {
      const instant = now();
      const limit = limitFor(limits, tier);
      const current = bucketOf(instant);
      // The window holds this minute and the ones before it, so a bucket
      // leaves exactly one window after the minute it began in.
      const earliest = bucketOf(new Date(instant.getTime() - (windowMinutes - 1) * 60_000));

      const rows = await db
        .select({ bucketStart: rateWindows.bucketStart, count: rateWindows.count })
        .from(rateWindows)
        .where(and(eq(rateWindows.subject, subject), gte(rateWindows.bucketStart, earliest)));

      const used = rows.reduce((sum, row) => sum + row.count, 0);

      if (used >= limit) {
        // The wait is until the oldest bucket that still counts leaves the
        // window, because that is the first moment one more command fits.
        const oldest = rows
          .filter(row => row.count > 0)
          .reduce((lowest, row) => (lowest === null || row.bucketStart < lowest ? row.bucketStart : lowest),
            null as string | null);
        const leavesAt = oldest === null
          ? instant.getTime()
          : instantOf(oldest) + windowMinutes * 60_000;
        const retryAfterSeconds = Math.max(1, Math.ceil((leavesAt - instant.getTime()) / 1000));
        return { allowed: false, used, limit, retryAfterSeconds };
      }

      // One process holds the gateway, so two commands from one person are
      // handled one after the other and this read and write cannot interleave
      // with themselves. The increment is still written as an increment
      // rather than as a stored count, so that a second process would
      // undercount by at most the commands in flight.
      await db
        .insert(rateWindows)
        .values({ subject, bucketStart: current, count: 1 })
        .onDuplicateKeyUpdate({ set: { count: sql`${rateWindows.count} + 1` } });

      return { allowed: true, used, limit, retryAfterSeconds: 0 };
    },

    async sweep(): Promise<number> {
      const cutoff = bucketOf(new Date(now().getTime() - keepMinutes * 60_000));
      const result = await db.delete(rateWindows).where(lt(rateWindows.bucketStart, cutoff));
      return (result as unknown as [{ affectedRows: number }])[0].affectedRows;
    },
  };
}
