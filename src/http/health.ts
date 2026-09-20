import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('health');

export interface HealthReport {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  details: Record<string, unknown>;
}

export interface HealthServerOptions {
  port: number;
  /** Runs the readiness checks. Throwing marks the service as not ready. */
  check: () => Promise<HealthReport>;
}

/**
 * A deliberately tiny HTTP server.
 *
 * The original project shipped Express, Swagger, CORS, helmet, compression,
 * hpp and morgan for an API whose every route was empty — the only thing that
 * ever answered was `GET /` returning 200. That is eight dependencies, a routing
 * layer and a documentation surface to keep patched, in service of nothing.
 *
 * What a container actually needs is two answers: "is this process alive?" and
 * "can it do useful work?". `node:http` provides both in a few lines, with no
 * dependencies at all.
 *
 *   GET /health — liveness. Always 200 while the process is running.
 *   GET /ready  — readiness. 200 only when the database and the bot are usable.
 */
export class HealthServer {
  private server: Server | null = null;

  private readonly startedAt = Date.now();

  constructor(private readonly options: HealthServerOptions) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      return;
    }

    this.server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        log.error({ err: error }, 'health request failed');
        this.respond(response, 500, { status: 'error' });
      });
    });

    // Node's default request timeout is generous; a health probe should never
    // hold a socket open for long.
    this.server.keepAliveTimeout = 5_000;
    this.server.headersTimeout = 10_000;

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, '0.0.0.0', () => {
        this.server?.removeListener('error', reject);
        resolve();
      });
    });

    log.info({ port: this.options.port }, 'health server listening');
  }

  async stop(): Promise<void> {
    const server = this.server;

    if (server === null) {
      return;
    }

    this.server = null;

    await new Promise<void>(resolve => {
      server.close(() => resolve());
      // Idle keep-alive sockets would otherwise delay the close indefinitely.
      server.closeIdleConnections();
    });
  }

  /**
   * The port actually bound.
   *
   * Differs from the configured value when port 0 was requested, which is how
   * the test suite avoids colliding with anything already listening.
   */
  get boundPort(): number | null {
    const address = this.server?.address();

    if (address === null || address === undefined || typeof address === 'string') {
      return null;
    }

    return address.port;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0];

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.respond(response, 405, { status: 'error', message: 'method not allowed' });
      return;
    }

    if (path === '/health') {
      this.respond(response, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1_000),
      });
      return;
    }

    if (path === '/ready') {
      try {
        const report = await this.options.check();
        this.respond(response, report.status === 'ok' ? 200 : 503, {
          status: report.status,
          uptimeSeconds: report.uptimeSeconds,
          ...report.details,
        });
      } catch (error) {
        this.respond(response, 503, {
          status: 'degraded',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    this.respond(response, 404, { status: 'error', message: 'not found' });
  }

  private respond(response: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);

    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });

    response.end(payload);
  }
}
