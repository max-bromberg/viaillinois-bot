import { createServer, type Server } from 'node:http';

/**
 * The health endpoint the cutover gates on.
 *
 * Readiness, not liveness. It has to fail when the process is running but
 * cannot do its job: no gateway connection, a database that does not answer or
 * was never migrated, or a web platform that does not answer. Every check is
 * an injected probe, so the listener is tested without any of the three.
 */
export interface HealthProbes {
  /** The bot version, from package.json. */
  version: string;
  /** The most recently applied migration, or null when there is none. */
  migrationVersion: () => Promise<string | null>;
  /** Whether the gateway connection is up. */
  gateway: () => boolean;
  /** Whether the bot database answers a query. */
  database: () => Promise<boolean>;
  /** Whether the web platform's internal service API answers. */
  viaPlatform: () => Promise<boolean>;
  /**
   * How far through the outbox the consumer has read and when it last looked.
   * The consumer holds no connection anybody can probe from outside, and one
   * that has quietly stopped looks exactly like one with nothing to do, so the
   * cutover reads these two fields to tell them apart. It is not a readiness
   * check: a bot that started a moment ago has not polled yet, and refusing
   * the deploy for that would refuse every deploy.
   */
  outboxConsumer?: () => ConsumerReport;
  /**
   * When the scheduler last made a pass. The digests and the reminders are
   * owed to people rather than asked for by them, so a scheduler that has
   * quietly stopped is worth seeing, and it is reported for the same reason
   * the consumer is and on the same terms: it is not a readiness check.
   */
  scheduler?: () => SchedulerReport;
  /**
   * When the housekeeping last pruned the rows section 10 of the design keeps
   * for ninety days, and whether it knows the bot has fallen behind the outbox
   * and has not yet rebuilt what it mirrors. Reported for the same reason the
   * scheduler is, and on the same terms: it is not a readiness check, because
   * a bot that started this morning has pruned nothing yet.
   */
  housekeeping?: () => HousekeepingReport;
}

/** What the housekeeping says about itself, or nothing before its first run. */
export interface HousekeepingReport {
  lastPruneAt: string | null;
  reconciliationPending: boolean;
}

/** What the scheduler says about itself, or nothing before its first pass. */
export interface SchedulerReport {
  lastTickAt: string | null;
}

/** What the consumer says about itself, or nothing before its first poll. */
export interface ConsumerReport {
  cursor: number | null;
  lastPollAt: string | null;
}

export interface HealthReport {
  status: 'ok' | 'unavailable';
  version: string;
  migrationVersion: string | null;
  gateway: boolean;
  database: boolean;
  viaPlatform: boolean;
  /** The last outbox entry the consumer finished, or null before its first poll. */
  outboxCursor: number | null;
  /** When the consumer last read the outbox, in campus wall clock. */
  lastPollAt: string | null;
  /** When the scheduler last made a pass, in campus wall clock. */
  schedulerLastTickAt: string | null;
  /** When the rows kept for ninety days were last pruned, in campus wall clock. */
  lastPruneAt: string | null;
  /** Whether the bot has fallen behind the outbox and not yet caught up another way. */
  reconciliationPending: boolean;
}

export interface HealthServer {
  /** The port actually bound, which matters when the caller asked for zero. */
  port: number;
  close: () => Promise<void>;
}

/**
 * How long an answer from the web platform's internal service API is held.
 *
 * The health port answers anybody who can reach it, and the cutover polls it
 * every second or two while it waits for the container to come up. Making one
 * call to the web platform for each of those would be the bot's own health
 * check adding load to a web platform that may already be in trouble, which is
 * exactly when the check matters. A few seconds is short enough that the
 * cutover still sees the state change within one of its polls.
 */
export const VIA_PROBE_TTL_MS = 5_000;

/**
 * A probe whose answer is held for a moment, so that a burst of hits on the
 * health port costs one call rather than one each.
 *
 * Hits that arrive while a call is still out share that call rather than
 * making their own. A refusal is held as well as an answer, because a web
 * platform that is not answering is the case where the hits matter most, and
 * the first caller still reads the reason so that it reaches the log once.
 */
export function heldFor(
  probe: () => Promise<boolean> | boolean,
  options: { ttlMs?: number; now?: () => Date } = {},
): () => Promise<boolean> {
  const { ttlMs = VIA_PROBE_TTL_MS, now = () => new Date() } = options;
  let held: { answer: boolean; expiresAt: number } | null = null;
  let inFlight: Promise<boolean> | null = null;

  return async function ask(): Promise<boolean> {
    if (held && held.expiresAt > now().getTime()) return held.answer;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const answer = Boolean(await probe());
        held = { answer, expiresAt: now().getTime() + ttlMs };
        return answer;
      } catch (err) {
        held = { answer: false, expiresAt: now().getTime() + ttlMs };
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

/**
 * A probe that throws is a probe that failed. The reason stays in the log: a
 * database error carries the host, the user and driver internals, and this
 * endpoint answers anyone who can reach the port.
 */
async function probe(name: string, fn: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return Boolean(await fn());
  } catch (err) {
    console.error(`health check ${name} failed:`, (err as Error).message);
    return false;
  }
}

/** Run every probe and assemble the document the endpoint answers with. */
export async function healthReport(probes: HealthProbes): Promise<{ code: number; body: HealthReport }> {
  let migrationVersion: string | null = null;
  try {
    migrationVersion = await probes.migrationVersion();
  } catch (err) {
    console.error('health check migrationVersion failed:', (err as Error).message);
  }
  const [gateway, database, viaPlatform] = await Promise.all([
    probe('gateway', probes.gateway),
    probe('database', probes.database),
    probe('viaPlatform', probes.viaPlatform),
  ]);

  let consumer: ConsumerReport = { cursor: null, lastPollAt: null };
  try {
    consumer = probes.outboxConsumer?.() ?? consumer;
  } catch (err) {
    // A consumer that cannot say where it is says nothing, rather than
    // failing a check that is about the three connections.
    console.error('health check outboxConsumer failed:', (err as Error).message);
  }

  let scheduler: SchedulerReport = { lastTickAt: null };
  try {
    scheduler = probes.scheduler?.() ?? scheduler;
  } catch (err) {
    // A scheduler that cannot say when it last ran says nothing, rather than
    // failing a check that is about the three connections.
    console.error('health check scheduler failed:', (err as Error).message);
  }

  let housekeeping: HousekeepingReport = { lastPruneAt: null, reconciliationPending: false };
  try {
    housekeeping = probes.housekeeping?.() ?? housekeeping;
  } catch (err) {
    // Housekeeping that cannot say what it has done says nothing, rather than
    // failing a check that is about the three connections.
    console.error('health check housekeeping failed:', (err as Error).message);
  }

  const ok = migrationVersion !== null && gateway && database && viaPlatform;
  return {
    code: ok ? 200 : 503,
    body: {
      status: ok ? 'ok' : 'unavailable',
      version: probes.version,
      migrationVersion,
      gateway,
      database,
      viaPlatform,
      outboxCursor: consumer.cursor,
      lastPollAt: consumer.lastPollAt,
      schedulerLastTickAt: scheduler.lastTickAt,
      lastPruneAt: housekeeping.lastPruneAt,
      reconciliationPending: housekeeping.reconciliationPending,
    },
  };
}

/**
 * Listen on the given port, answering GET /health and nothing else. Port zero
 * asks the operating system for a free one, which is what the tests use.
 */
export function startHealthServer(probes: HealthProbes, port: number): Promise<HealthServer> {
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found.' }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
      res.end(JSON.stringify({ error: 'Method not allowed.' }));
      return;
    }
    const { code, body } = await healthReport(probes);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: bound,
        close: () => new Promise<void>((done, fail) => {
          server.close(err => (err ? fail(err) : done()));
          // Keep alive connections would otherwise hold close() open until
          // they time out, which makes every test wait on nothing.
          server.closeAllConnections();
        }),
      });
    });
  });
}
