# 5. Single-container deployment

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

The previous version ran under PM2 across two instances, while conversation state
was kept in the memory of the process that received it. The result was a real
bug: a user whose first message reached instance one and whose second message
reached instance two was lost mid-wizard.

At the same time, every second instance was a separate scheduler, so auto-reserve
ran twice and could book the same meal twice.

## Decision

One container, with an in-process scheduler (`node-cron`).

- `docker compose` with a single service.
- A `bot-data` volume on `/app/data` for the SQLite file.
- A non-root user, a read-only filesystem and a `tmpfs` for `/tmp`.
- Resource limits and a `restart: unless-stopped` policy.
- `tini` as PID 1, so signals reach Node and the final WAL checkpoint runs before
  `SIGKILL`.

### Why the scheduler runs in-process

The alternative was to run the scheduler in a separate container, or to use the
host's cron. The cost of that is two services that have to stay in step and both
need access to the same database and the same secrets. With one replica, an
in-process scheduler gives the same guarantee without the complexity.

To make a concurrent auto-reserve run impossible, a `Mutex` wraps the runs and
**skips** the next tick on contention rather than queueing it. Queueing would mean
one slow run producing a series of back-to-back runs that all repeat a stale plan.

## Consequences

**Positive**

- The lost-conversation-state bug was fixed at the root, rather than by moving the
  cache to a shared service.
- Auto-reserve never runs twice.
- One service to deploy, monitor and update.
- A stricter security profile became possible: a read-only filesystem, no
  `new-privileges`, and running as the `node` user.

**Negative**

- There is no redundancy. If the server dies, the bot is unreachable until the
  container comes back up. That is acceptable for a university bot: 99.9%
  availability is not required, and would cost several times what it is worth.
- `restart: unless-stopped` only reacts to process exit. A container that turns
  `unhealthy` while its process is still alive is not restarted automatically.
  That is deliberate: blindly restarting a live but broken process usually makes
  the problem worse.
- It can be broken easily with `docker compose up -d --scale bot=2`. If that is
  ever needed, read [ADR 2](0002-in-memory-cache-instead-of-redis.md) first.

**Failure mode to be aware of**

If the scheduler does not run for any reason — the container was not up at 07:00,
say — auto-reserve does not happen that day. Because auto-reserve works *ahead of
capacity filling up* rather than at the moment of the meal, missing one run means
losing a day. If that becomes important, the next step is to run auto-reserve at
container start-up, not to add a replica.
