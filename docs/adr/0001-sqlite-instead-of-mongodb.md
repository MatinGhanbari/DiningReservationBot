# 1. SQLite with WAL instead of MongoDB

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

The previous version ran on MongoDB with Mongoose, although it had only four
collections: users, forget codes, broken-code reports and support tickets. The
volume of data one university produces is a few thousand records a year, and none
of it has complex relations or needs analytical queries.

MongoDB, on the other hand, had a real cost: a separate service to install,
configure, back up and monitor, plus a network hop on the path of every message.
For a bot that reads a few records per message, that hop was more expensive than
the query itself.

## Decision

SQLite through `better-sqlite3`, with the parameters tuned for in-memory
behaviour:

```sql
journal_mode = WAL        -- reads and writes at the same time, no global lock
synchronous  = NORMAL     -- no fsync on every transaction
mmap_size    = 256 MB     -- the whole file in the process address space
cache_size   = -64 MB     -- page cache in memory
temp_store   = MEMORY     -- temporary tables and sorts in RAM
busy_timeout = 5s
foreign_keys = ON
```

`better-sqlite3` was chosen over the async drivers because it is synchronous:
there is no promise between the call and the result, which is both faster and
simpler to transact with. In single-threaded Node, a synchronous read from an
in-memory cache costs effectively nothing.

## Consequences

**Positive**

- One dependency instead of one service: a backup is a file copy.
- Zero network hops on the path of every message.
- Real `ACID` transactions, which MongoDB without a replica set did not guarantee.
- `VACUUM INTO` makes a consistent backup possible while the bot is running.

**Negative**

- `synchronous = NORMAL` with WAL can lose the last few transactions on a power
  cut — not the database itself. That is acceptable, because every transaction is
  either re-saving login details or donating a forget code, and the user can
  repeat either one.
- Horizontal scaling of the database is not possible. If it is ever needed, the
  natural path is Postgres, and the `db/` layer is the only place that has to
  change.

**Neutral**

- The previous MongoDB data was not migrated. A migration would have been
  required, but since every user can sign in again, it was not justified.
