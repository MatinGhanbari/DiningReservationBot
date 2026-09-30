# 9. Redis for all storage, instead of SQLite

- **Status:** Accepted
- **Date:** 2026 (1405 AP)
- **Supersedes:** [1](0001-sqlite-instead-of-mongodb.md)
- **Partially supersedes:** [2](0002-in-memory-cache-instead-of-redis.md) — the cache half still stands

## Context

The owner asked for every piece of data to move to Redis, with the server running
beside the bot and a persisted volume so a restart cannot lose it. The stated
reason was that "the services that touch the database are slow and very weak".

That claim was measured before anything was changed, because [ADR 1](0001-sqlite-instead-of-mongodb.md)
had already rejected a networked database for this exact reason and it was worth
knowing whether the reason still held. A throwaway benchmark drove the **real
repository classes** against a **real file-backed database** seeded with 5,000
users, 5,000 tickets, 80,000 support messages, 200,000 chatbot messages and 20,000
forget codes (56.9 MB, schema v4), timing the calls a Telegram update actually
makes. p50 per operation:

| operation | p50 |
|---|---|
| `sessions.get` (in-process) | 0.3 µs |
| `support.findOpenTicket` | 6 µs |
| `users.findByTelegramId` (every guarded update) | 13 µs |
| `forgetCodes.claim` (atomic) | 15 µs |
| `users.save` (login) | 51 µs |
| `chatbot.historyForUser(10)` | 60 µs |
| **floor: loopback TCP round trip** | **84 µs** |
| **floor: loopback HTTP round trip** | **436 µs** |
| `support.countMessagesSince` | 2.5 ms |
| `chatbot.countUsersSince` | 7.7 ms |
| `users.findAllWithAutoReserveEnabled` | 19.0 ms |
| `AdminService.overview()` (whole panel screen) | 32.4 ms |

Three things follow, and they are the whole of this record:

1. **The hot path was never the bottleneck.** 6–60 µs against a Telegram round
   trip of 50–200 ms puts storage at roughly 0.05% of any message's latency.
2. **A Redis command cannot cost less than the 84 µs loopback floor** — six times
   the cost of `findByTelegramId` — and a real one adds protocol parsing and a hop
   over the Docker bridge. Moving the stores to Redis makes every storage call
   **10–30× slower**, not faster. This is ADR 1's own argument, applied to the
   store it did not cover.
3. **The two genuinely slow operations were both in the admin panel and both
   fixed by the move as a side effect:** `findAllWithAutoReserveEnabled` was an
   N+1 (one extra weekday query per row) and `chatbot.countUsersSince` was a
   `COUNT(DISTINCT …)` with no covering index. The Redis versions answer them with
   two pipelined round trips and a `SCARD`.

The decision was taken with those numbers in hand and the trade stated: this is a
deliberate move to a networked store, made for operational reasons rather than for
speed.

## Decision

Every store moves to Redis. The SQLite layer, its migrations and `better-sqlite3`
are deleted; nothing falls back to a file.

- **Keyspace in one place.** `src/db/redis/store.ts` is the only module that names
  a key. There is no `CREATE TABLE` to read, so an auditable flat list of key
  builders is what stands in for a schema.
- **One hash per entity, one index per access path.** `user:{id}` is a hash;
  `users:byId` and `users:byCreatedAt` are sorted sets because the broadcast walks
  by id while the panel pages by date and neither order derives from the other.
- **Invariants that were unique indexes become claimed keys.** The one Samad
  account ↔ one Telegram account rule is a `SET NX` on
  `users:samad:{universityId}:{username}`. Printing the same forget code twice is
  refused by an `SADD` on `codes:seen:{universityId}:{selfId}`.
- **Operations that were one statement become one script.** The atomic claim is
  `ZPOPMIN` inside a Lua script, which also marks the row and clears the indexes,
  so a crash cannot leave a code popped but unclaimed. Closing a ticket only while
  it is open is a script, so two admins cannot both be told they closed it.
- **Counts that needed a scan become cardinalities.** A meal's available codes are
  a sorted set, so `hasAvailableForMeal` is a `ZCARD` rather than an index probe.
- **The daily quota is a per-day counter with a TTL**, because the budget resets at
  midnight in the configured timezone and a counter that expires needs no sweep.
  This assumes a day-aligned `since`; both call sites pass `startOfConfiguredDay`.
- **Durability is the server's job and is configured there.** `docker-compose.yml`
  runs `redis:8-alpine` with `--appendonly yes --appendfsync everysec` on a named
  volume, and the bot waits for its health check. Redis is not published to the
  host. A Redis without an AOF is a cache, and pointing `REDIS_URL` at one discards
  every account on the next restart.
- **Nothing was migrated.** As in ADR 1, every user can sign in again and the
  forget-code pool is rebuilt from sharing, so a one-shot SQLite→Redis importer was
  not worth owning.

## Consequences

**Positive**

- The admin panel got faster rather than slower: `overview()` was 32.4 ms of which
  27 ms was the two operations above, and both are now a round trip or a cardinality
  read.
- Durability has a single, well-understood story: an append-only file on a volume,
  rather than WAL plus `synchronous = NORMAL` plus a checkpoint at shutdown.
- The `better-sqlite3` native module is gone, which removes the constraint that
  pinned the project to Node 22 — it publishes no prebuilt binary for newer ABIs.
  The image is now on Node 24, the Active LTS.
- Sessions and conversation state are the only in-process state left, which makes
  what a second replica would still need explicit (see ADR 2's revisit condition).

**Negative**

- **Every storage call is 10–30× slower.** Measured, and accepted: the absolute
  cost is tens of microseconds against a 50–200 ms Telegram round trip, so it does
  not show up in any latency a user can perceive.
- **Redis is now on the critical path of everything.** An unreachable Redis is not a
  degraded bot, it is a stopped one. `/ready` answers `503`, and the compose file
  makes the bot wait for the server rather than start and retry.
- **A hand-written snapshot replaced `VACUUM INTO`.** The bot runs in its own
  container and cannot read Redis' data directory, so the admin's backup walks the
  keyspace and dumps each value. It is slower and it is not a point-in-time copy
  across keys, unlike `VACUUM INTO`.
- **The test suite needs a real server.** Redis is not a query language and its
  scripts are the thing under test, so a mock would test the mock. Tests take their
  own random key prefix instead of flushing a shared database.
- **Relational queries became maintained indexes.** `listOpen` used to be one
  statement with two correlated subqueries; it is now a sorted set plus four piped
  commands per ticket. Every new access path is a new structure to keep in step, and
  nothing in the type system enforces that.
- **Ordering had to be preserved by hand.** The claim is FIFO because the meal set
  is scored by creation time. A `SET` would have been simpler and would have
  silently changed which code a student receives.

**Revisit when**

- The dataset outgrows one server's memory. Nothing here is partitioned, and every
  index is a full copy of the relation it serves.
- A query appears that needs a join or an ad-hoc filter. Redis has no planner; the
  answer would be a second index or a different store, not a clever key.
- Multi-key atomicity is needed across two entities. The scripts are single-entity
  by construction, and a cross-entity transaction would have to be designed rather
  than written.
