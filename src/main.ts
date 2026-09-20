import { config } from './config/env';
import { createContainer } from './container';
import { logger, scopedLogger } from './shared/logger';
import { SECOND } from './shared/time';

const log = scopedLogger('main');

/**
 * How long to wait for in-flight work before exiting anyway.
 *
 * Docker sends SIGKILL ten seconds after SIGTERM by default. Giving up at eight
 * means the database is closed and the log line is written, rather than the
 * process being killed mid-checkpoint.
 */
const SHUTDOWN_GRACE_MS = 8 * SECOND;

async function main(): Promise<void> {
  const container = createContainer();

  await container.start();

  let signalled = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (signalled) {
      // A second Ctrl-C means "stop waiting".
      log.warn({ signal }, 'received a second signal, exiting immediately');
      process.exit(1);
    }

    signalled = true;

    const timer = setTimeout(() => {
      log.error({ graceMs: SHUTDOWN_GRACE_MS }, 'shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);

    // `unref` lets the process exit as soon as shutdown finishes, without
    // waiting out the full grace period.
    timer.unref();

    void container.shutdown(signal).then(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  /**
   * A bug that reaches here leaves the process in an unknown state, so it is
   * logged, shut down cleanly, and left to the container's restart policy.
   * Continuing to serve requests after an uncaught exception is how a bot starts
   * replying with nonsense.
   */
  process.on('uncaughtException', error => {
    log.fatal({ err: error }, 'uncaught exception');
    void container.shutdown('uncaughtException').then(() => process.exit(1));
  });

  process.on('unhandledRejection', reason => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    void container.shutdown('unhandledRejection').then(() => process.exit(1));
  });

  log.info({ env: config.NODE_ENV, timezone: config.TZ, level: config.LOG_LEVEL }, 'process is up');
}

main().catch(error => {
  // Logged through the raw logger: the container may not exist yet, so there is
  // no graceful shutdown to attempt.
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
