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
}

export interface HealthReport {
  status: 'ok' | 'unavailable';
  version: string;
  migrationVersion: string | null;
  gateway: boolean;
  database: boolean;
  viaPlatform: boolean;
}

export interface HealthServer {
  /** The port actually bound, which matters when the caller asked for zero. */
  port: number;
  close: () => Promise<void>;
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
