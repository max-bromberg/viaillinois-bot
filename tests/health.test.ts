import { describe, it, expect, afterEach } from 'vitest';
import { startHealthServer, type HealthProbes, type HealthServer } from '../src/health.ts';

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
