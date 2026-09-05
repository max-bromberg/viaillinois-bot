import { describe, it, expect, afterEach } from 'vitest';
import {
  startHealthServer, heldFor, VIA_PROBE_TTL_MS,
  type HealthProbes, type HealthServer,
} from '../src/health.ts';

/** Probes that all answer well, for the tests to break one at a time. */
function healthyProbes(): HealthProbes {
  return {
    version: '0.0.0',
    migrationVersion: async () => '0000_baseline',
    gateway: () => true,
    database: async () => true,
    viaPlatform: async () => true,
  };
}

let server: HealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Start on an ephemeral port and fetch the health document. */
async function health(probes: HealthProbes): Promise<{ status: number; body: any }> {
  server = await startHealthServer(probes, 0);
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  return { status: response.status, body: await response.json() };
}

describe('GET /health', () => {
  it('answers 200 with every field when every probe answers well', async () => {
    const { status, body } = await health(healthyProbes());
    expect(status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      version: '0.0.0',
      migrationVersion: '0000_baseline',
      gateway: true,
      database: true,
      viaPlatform: true,
      outboxCursor: null,
      lastPollAt: null,
      schedulerLastTickAt: null,
      lastPruneAt: null,
      reconciliationPending: false,
    });
  });

  it('answers 503 when the gateway is not connected', async () => {
    const { status, body } = await health({ ...healthyProbes(), gateway: () => false });
    expect(status).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.gateway).toBe(false);
    expect(body.database).toBe(true);
  });

  it('answers 503 when the database does not answer', async () => {
    const { status, body } = await health({ ...healthyProbes(), database: async () => false });
    expect(status).toBe(503);
    expect(body.database).toBe(false);
  });

  it('answers 503 when the database probe throws, and keeps the reason out of the answer', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      database: async () => {
        throw new Error("Access denied for user 'via_bot'@'172.19.0.14' (using password: YES)");
      },
    });
    expect(status).toBe(503);
    expect(body.database).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/via_bot@|172\.|Access denied|password/i);
  });

  it('answers 503 when no migration has been applied', async () => {
    const { status, body } = await health({ ...healthyProbes(), migrationVersion: async () => null });
    expect(status).toBe(503);
    expect(body.migrationVersion).toBe(null);
  });

  it('answers 503 when the migration version cannot be read', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      migrationVersion: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(status).toBe(503);
    expect(body.migrationVersion).toBe(null);
  });

  it('answers 503 when the web platform does not answer', async () => {
    const { status, body } = await health({ ...healthyProbes(), viaPlatform: async () => false });
    expect(status).toBe(503);
    expect(body.viaPlatform).toBe(false);
  });

  it('answers 503 when the web platform probe throws', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      viaPlatform: async () => { throw new Error('fetch failed'); },
    });
    expect(status).toBe(503);
    expect(body.viaPlatform).toBe(false);
  });

  it('answers 404 for any other path and 405 for any other method', async () => {
    server = await startHealthServer(healthyProbes(), 0);
    const other = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(other.status).toBe(404);
    const post = await fetch(`http://127.0.0.1:${server.port}/health`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('reports the port it actually bound', async () => {
    server = await startHealthServer(healthyProbes(), 0);
    expect(server.port).toBeGreaterThan(0);
  });
});

/**
 * The consumer is the half of the bot nobody can see from outside: it holds no
 * connection anybody can probe, and a consumer that has quietly stopped looks
 * exactly like one with nothing to do. So the health endpoint reports how far
 * through the outbox it has read and when it last looked, and the cutover can
 * tell the two apart.
 */
describe('what the health endpoint says about the outbox consumer', () => {
  it('reports the cursor and the last poll when a consumer is running', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      outboxConsumer: () => ({ cursor: 42, lastPollAt: '2026-09-05 09:30:00' }),
    });
    expect(status).toBe(200);
    expect(body.outboxCursor).toBe(42);
    expect(body.lastPollAt).toBe('2026-09-05 09:30:00');
  });

  it('reports nothing rather than a made up cursor before the first poll', async () => {
    const { body } = await health({
      ...healthyProbes(),
      outboxConsumer: () => ({ cursor: null, lastPollAt: null }),
    });
    expect(body.outboxCursor).toBe(null);
    expect(body.lastPollAt).toBe(null);
  });

  /**
   * The consumer is not a readiness check. A bot whose consumer has not polled
   * yet is a bot that started a moment ago, and refusing the deploy for that
   * would refuse every deploy.
   */
  it('still answers 200 when the consumer has not polled yet', async () => {
    const { status } = await health({
      ...healthyProbes(),
      outboxConsumer: () => ({ cursor: null, lastPollAt: null }),
    });
    expect(status).toBe(200);
  });

  it('reports nothing rather than failing when the consumer state cannot be read', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      outboxConsumer: () => { throw new Error('the consumer is not wired'); },
    });
    expect(status).toBe(200);
    expect(body.outboxCursor).toBe(null);
    expect(body.lastPollAt).toBe(null);
  });
});

/**
 * The scheduler is reported for the same reason the consumer is: a scheduler
 * that has quietly stopped looks exactly like one with nothing to do, and the
 * cutover has to be able to tell them apart. It is not a readiness check
 * either, because a bot that started a moment ago has not made a pass yet.
 */
describe('what the health endpoint says about the scheduler', () => {
  it('reports when the scheduler last made a pass', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      scheduler: () => ({ lastTickAt: '2026-09-05 09:30:00' }),
    });
    expect(status).toBe(200);
    expect(body.schedulerLastTickAt).toBe('2026-09-05 09:30:00');
  });

  it('reports nothing rather than a made up time before the first pass', async () => {
    const { body } = await health({ ...healthyProbes(), scheduler: () => ({ lastTickAt: null }) });
    expect(body.schedulerLastTickAt).toBe(null);
  });

  it('reports nothing rather than failing when the scheduler state cannot be read', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      scheduler: () => { throw new Error('the scheduler is not wired'); },
    });
    expect(status).toBe(200);
    expect(body.schedulerLastTickAt).toBe(null);
  });
});

/**
 * The housekeeping is reported for the same reason the scheduler is. A prune
 * that stopped happening is invisible until the database is large, and a
 * reconciliation left pending means a server's Events tab may be out of date,
 * which is worth seeing rather than guessing at. Neither is a readiness check:
 * a bot that started this morning has pruned nothing yet.
 */
describe('what the health endpoint says about the housekeeping', () => {
  it('reports when the rows were last pruned and whether a reconciliation is owed', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      housekeeping: () => ({ lastPruneAt: '2026-09-05 04:00:00', reconciliationPending: true }),
    });
    expect(status).toBe(200);
    expect(body.lastPruneAt).toBe('2026-09-05 04:00:00');
    expect(body.reconciliationPending).toBe(true);
  });

  it('reports nothing rather than a made up time before the first prune', async () => {
    const { body } = await health({
      ...healthyProbes(),
      housekeeping: () => ({ lastPruneAt: null, reconciliationPending: false }),
    });
    expect(body.lastPruneAt).toBe(null);
    expect(body.reconciliationPending).toBe(false);
  });

  it('reports nothing rather than failing when the housekeeping state cannot be read', async () => {
    const { status, body } = await health({
      ...healthyProbes(),
      housekeeping: () => { throw new Error('the housekeeping is not wired'); },
    });
    expect(status).toBe(200);
    expect(body.lastPruneAt).toBe(null);
    expect(body.reconciliationPending).toBe(false);
  });
});

/**
 * The probe that reaches the web platform.
 *
 * The health port answers anybody who can reach it, and the cutover polls it
 * while it waits for the container to come up. Every one of those hits calling
 * the internal service API would be the bot's own health check adding load to
 * a web platform that may already be struggling, so the answer is held for a
 * few seconds and the hits inside that share it.
 */
describe('holding the answer the web platform gave', () => {
  function probe(answers: Array<() => boolean | Promise<boolean>>) {
    let clock = new Date('2026-09-05T14:30:00Z');
    let asked = 0;
    const held = heldFor(
      async () => {
        const next = answers[Math.min(asked, answers.length - 1)]!;
        asked += 1;
        return next();
      },
      { now: () => clock },
    );
    return {
      held,
      asked: () => asked,
      advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
    };
  }

  it('holds the answer for the few seconds it names', () => {
    expect(VIA_PROBE_TTL_MS).toBe(5_000);
  });

  it('asks the web platform once for every hit inside those seconds', async () => {
    const { held, asked } = probe([() => true]);
    expect(await held()).toBe(true);
    expect(await held()).toBe(true);
    expect(await held()).toBe(true);
    expect(asked()).toBe(1);
  });

  it('asks again once they are over', async () => {
    const { held, asked, advance } = probe([() => true]);
    await held();
    advance(VIA_PROBE_TTL_MS - 1);
    await held();
    expect(asked()).toBe(1);

    advance(2);
    await held();
    expect(asked()).toBe(2);
  });

  it('asks once for hits that arrive at the same moment', async () => {
    const { held, asked } = probe([() => true]);
    const answers = await Promise.all([held(), held(), held()]);
    expect(answers).toEqual([true, true, true]);
    expect(asked()).toBe(1);
  });

  /**
   * A web platform that is not answering is the case where the hits matter
   * most, so a refusal is held as well and reported as a refusal.
   */
  it('holds a failure too, rather than asking a web platform that is down on every hit', async () => {
    const { held, asked } = probe([() => { throw new Error('the web platform did not answer'); }]);
    await expect(held()).rejects.toThrow('the web platform did not answer');
    expect(await held()).toBe(false);
    expect(asked()).toBe(1);
  });
});
