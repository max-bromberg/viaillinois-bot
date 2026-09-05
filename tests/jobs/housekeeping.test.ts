import { describe, it, expect, beforeEach } from 'vitest';
import {
  createHousekeepingJob, HOUSEKEEPING_HOUR, OUTBOX_RETENTION_DAYS, RETENTION_DAYS,
} from '../../src/jobs/housekeeping.ts';
import { ANNOUNCEMENTS_CONSUMER, type CursorState, type OutboxCursors } from '../../src/outbox/cursor.ts';
import { memoryGuildStore } from '../commands/support.ts';
import type { GuildInstallation, GuildStore } from '../../src/guilds/store.ts';
import type { JobHour } from '../../src/jobs/scheduler.ts';

/**
 * The housekeeping that keeps the bot healthy.
 *
 * Two things happen once a day. Section 10 of the design keeps Deliveries and
 * Rate_Windows for ninety days and nothing longer, so rows older than that go.
 * And the outbox is pruned on the web platform after thirty days, so a cursor
 * that has not moved in longer than that points at entries which no longer
 * exist: the bot cannot catch up by reading the outbox, and it says so loudly
 * and rebuilds what it mirrors from the reading endpoints instead.
 */

const GUILD = '900000000000000001';
const OTHER = '900000000000000002';
const ROSA = '204255221017214977';

function hourOf(iso: string): JobHour {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  }).formatToParts(at);
  const field = (type: string) => parts.find(part => part.type === type)!.value;
  const day = `${field('year')}-${field('month')}-${field('day')}`;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    at,
    startedAt: `${day} ${field('hour')}:00:00`,
    day,
    hour: Number(field('hour')) % 24,
    dayOfWeek: weekdays[field('weekday')]!,
  };
}

/** The cursor in memory, which is one row and when it last moved. */
function memoryCursors(held: CursorState | null = null): OutboxCursors & { held: () => CursorState | null } {
  let state = held;
  return {
    held: () => state,
    async read() { return state?.lastOutboxId ?? 0; },
    async state() { return state; },
    async advance(consumer: string, lastOutboxId: number) {
      state = { lastOutboxId, updatedAt: '2026-09-05 04:00:00' };
    },
  };
}

describe('the daily housekeeping', () => {
  // Four in the morning on the campus clock, on the fifth of September.
  const EARLY = hourOf('2026-09-05T09:00:00Z');

  let pruned: { deliveriesBefore: string[]; windowsBefore: Date[] };
  let rolled: string[];
  let guilds: GuildStore;
  let cursors: ReturnType<typeof memoryCursors>;

  function built(options: { cursors?: OutboxCursors } = {}) {
    return createHousekeepingJob({
      deliveries: {
        async pruneBefore(intendedBefore: string) {
          pruned.deliveriesBefore.push(intendedBefore);
          return 3;
        },
      },
      rateWindows: {
        async pruneBefore(before: Date) {
          pruned.windowsBefore.push(before);
          return 5;
        },
      },
      cursors: options.cursors ?? cursors,
      guilds,
      mirror: {
        async rollGuild(installation: GuildInstallation) {
          rolled.push(installation.guildId);
          return 2;
        },
      },
    });
  }

  async function setUpServer(guildId: string) {
    await guilds.createInstallation(guildId, ROSA);
    await guilds.setKind(guildId, 'rso');
    await guilds.setBinding(guildId, { binding: 'rso', rsoId: 3, boundBy: ROSA });
  }

  beforeEach(async () => {
    pruned = { deliveriesBefore: [], windowsBefore: [] };
    rolled = [];
    guilds = memoryGuildStore();
    cursors = memoryCursors({ lastOutboxId: 41, updatedAt: '2026-09-05 03:00:00' });
  });

  it('runs early in the morning and at no other hour', async () => {
    expect(HOUSEKEEPING_HOUR).toBe(4);
    const result = await built().run(hourOf('2026-09-05T18:00:00Z'));
    expect(result.deliveries).toBe(0);
    expect(pruned.deliveriesBefore).toEqual([]);
  });

  it('prunes the deliveries and the rate windows older than ninety days', async () => {
    const result = await built().run(EARLY);

    expect(RETENTION_DAYS).toBe(90);
    expect(pruned.deliveriesBefore).toEqual(['2026-06-07 00:00:00']);
    // The same moment as the deliveries cutoff, which is the start of the
    // campus day ninety days back, given to the rate windows as an instant
    // because the column they are kept in holds UTC.
    expect(pruned.windowsBefore.map(before => before.toISOString()))
      .toEqual([new Date('2026-06-07T00:00:00-05:00').toISOString()]);
    expect(result.deliveries).toBe(3);
    expect(result.rateWindows).toBe(5);
  });

  it('says when it last pruned, for the health endpoint to report', async () => {
    const job = built();
    expect(job.state().lastPruneAt).toBe(null);
    await job.run(EARLY);
    expect(job.state().lastPruneAt).toBe('2026-09-05 04:00:00');
  });

  it('trusts the cursor while it is younger than the outbox retention', async () => {
    const job = built();
    const result = await job.run(EARLY);

    expect(OUTBOX_RETENTION_DAYS).toBe(30);
    expect(result.reconciled).toBe(0);
    expect(rolled).toEqual([]);
    expect(job.state().reconciliationPending).toBe(false);
  });

  /**
   * The web platform prunes the outbox after thirty days, so a cursor older
   * than that names an entry that has been deleted and everything between it
   * and the head is gone. Reading on from it would silently miss the lot.
   */
  it('rebuilds what it mirrors from the reading endpoints when the cursor is older than the outbox', async () => {
    await setUpServer(GUILD);
    await setUpServer(OTHER);
    const stale = memoryCursors({ lastOutboxId: 41, updatedAt: '2026-06-01 03:00:00' });

    const job = built({ cursors: stale });
    const result = await job.run(EARLY);

    expect(result.reconciled).toBe(2);
    expect(rolled.sort()).toEqual([GUILD, OTHER]);
    expect(job.state().reconciliationPending).toBe(false);
  });

  it('moves the cursor on once it has caught up another way, so it does not do it again tomorrow', async () => {
    await setUpServer(GUILD);
    const stale = memoryCursors({ lastOutboxId: 41, updatedAt: '2026-06-01 03:00:00' });

    await built({ cursors: stale }).run(EARLY);

    expect(stale.held()).toEqual({ lastOutboxId: 41, updatedAt: '2026-09-05 04:00:00' });
  });

  it('says a reconciliation is still pending when one of the servers failed', async () => {
    await setUpServer(GUILD);
    const stale = memoryCursors({ lastOutboxId: 41, updatedAt: '2026-06-01 03:00:00' });

    const job = createHousekeepingJob({
      deliveries: { async pruneBefore() { return 0; } },
      rateWindows: { async pruneBefore() { return 0; } },
      cursors: stale,
      guilds,
      mirror: {
        async rollGuild() { throw new Error('Discord is not answering'); },
      },
    });
    const result = await job.run(EARLY);

    expect(result.failed).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(job.state().reconciliationPending).toBe(true);
    // The cursor is left where it was, so the next run tries again.
    expect(stale.held()!.updatedAt).toBe('2026-06-01 03:00:00');
  });

  it('needs no reconciliation before the consumer has ever read the outbox', async () => {
    const job = built({ cursors: memoryCursors(null) });
    const result = await job.run(EARLY);

    expect(result.reconciled).toBe(0);
    expect(rolled).toEqual([]);
    expect(job.state().reconciliationPending).toBe(false);
  });

  it('prunes even when the reconciliation fails, because the two are separate jobs', async () => {
    await setUpServer(GUILD);
    const stale = memoryCursors({ lastOutboxId: 41, updatedAt: '2026-06-01 03:00:00' });

    const job = createHousekeepingJob({
      deliveries: {
        async pruneBefore(intendedBefore: string) {
          pruned.deliveriesBefore.push(intendedBefore);
          return 1;
        },
      },
      rateWindows: { async pruneBefore() { return 0; } },
      cursors: stale,
      guilds,
      mirror: { async rollGuild() { throw new Error('Discord is not answering'); } },
    });
    await job.run(EARLY);

    expect(pruned.deliveriesBefore).toEqual(['2026-06-07 00:00:00']);
  });

  it('reads the cursor of the consumer the first release runs', async () => {
    const asked: string[] = [];
    const watched: OutboxCursors = {
      async read() { return 0; },
      async state(consumer: string) { asked.push(consumer); return null; },
      async advance() {},
    };
    await built({ cursors: watched }).run(EARLY);
    expect(asked).toEqual([ANNOUNCEMENTS_CONSUMER]);
  });
});
