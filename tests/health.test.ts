import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthServer, type HealthReport } from '../src/http/health';

const healthyReport: HealthReport = {
  status: 'ok',
  uptimeSeconds: 12,
  details: { database: 'ok', users: 3 },
};

describe('HealthServer', () => {
  let server: HealthServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new HealthServer({
      // Port 0 lets the OS pick a free port, so the suite never collides with
      // something already listening on the developer's machine.
      port: 0,
      check: async () => healthyReport,
    });

    await server.start();

    const port = server.boundPort;
    if (port === null) {
      throw new Error('health server did not bind a port');
    }

    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('answers liveness while the process is running', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('answers readiness when the dependencies are usable', async () => {
    const response = await fetch(`${baseUrl}/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('reports 503 when a dependency check fails', async () => {
    await server.stop();

    server = new HealthServer({
      port: 0,
      check: async () => {
        throw new Error('database is gone');
      },
    });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.boundPort}/ready`);

    // A 200 here would keep a broken container in the load balancer.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('reports 503 when the check itself reports degradation', async () => {
    await server.stop();

    server = new HealthServer({
      port: 0,
      check: async () => ({ status: 'degraded', uptimeSeconds: 1, details: {} }),
    });
    await server.start();

    const response = await fetch(`http://127.0.0.1:${server.boundPort}/ready`);

    expect(response.status).toBe(503);
  });

  it('returns 404 for anything else', async () => {
    const response = await fetch(`${baseUrl}/metrics`);

    expect(response.status).toBe(404);
  });

  it('rejects methods other than GET and HEAD', async () => {
    const response = await fetch(`${baseUrl}/health`, { method: 'POST' });

    expect(response.status).toBe(405);
  });

  it('does not cache its answers', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('can be started twice without binding a second listener', async () => {
    const spy = vi.fn();
    await server.start().catch(spy);

    expect(spy).not.toHaveBeenCalled();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});
