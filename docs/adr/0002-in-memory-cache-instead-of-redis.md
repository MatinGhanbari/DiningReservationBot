# 2. In-memory cache instead of Redis

- **Status:** Accepted for the cache; see [9](0009-redis-for-all-storage.md) for the store
- **Date:** 2026 (1405 AP)

## Context

Redis did two things in the previous version: it held each user's Samad access
token, and it held conversation state in the middle of the sign-in wizard.

Both pieces of data are entirely transient. The token is rebuilt on the next
sign-in (the password is stored), and if conversation state is lost the user only
has to tap the button again.

The more serious problem was that the previous version ran under PM2 across **two
instances**, yet kept conversation state in an in-process `Map` rather than in
Redis. A user whose first message reached instance one and whose second message
reached instance two was therefore lost mid-wizard.

## Decision

Two in-memory caches over one shared structure:

- `TtlMap`: a bounded map with LRU eviction and expiry.
- `MemorySessionStore`: Samad sessions.
- `MemoryConversationStore`: conversation state.

Both have an entry cap and a TTL, and are swept periodically, so a process that
runs for months cannot grow memory without bound.

At the same time, the deployment moved to a **single container** (see
[ADR 5](0005-single-container-deployment.md)), which solves the same problem that
keeping state in Redis solved.

## Consequences

**Positive**

- One less dependency and one less service to install and monitor.
- Reads come from the process's own memory: no serialisation, no network.
- `TtlMap` has both expiry and a memory cap. The previous version's raw `Map` had
  neither, and was a slow memory leak.

**Negative**

- Restarting the container clears every session and every conversation state.
  Users have to sign in again, which is acceptable because signing in again is
  automatic.
- Horizontal scaling is not possible: two replicas means a user is lost
  mid-wizard depending on which container their message reaches.

**Revisit when**

If more than one replica is ever needed, `SessionStore` and `ConversationStore`
move to a shared service first. Both are ports, so the only place that has to
change is `container.ts`.

## Update (2026-09-30)

Half of this record still holds and half does not.

**Still holds:** sessions and conversation state stay in process memory. The
"revisit when" condition below is unchanged — a second replica is still what would
force them out, and Redis is now already running, so that move is cheaper than it
was.

**Does not hold:** the decision was framed as "one less dependency and one less
service to install and monitor". Redis is now required, because the data lives
there. See [ADR 9](0009-redis-for-all-storage.md).
