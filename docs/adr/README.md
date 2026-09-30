# Architecture decision records

Each record captures one decision that shaped the project, the context it was made
in, and what it cost. They are historical: a record is not edited when the code
moves on — a later record supersedes it, or the record gains an **Update**
section. Read them before proposing a change to the area they cover.

Format: **Status**, **Date**, **Context**, **Decision**, **Consequences**
(positive / negative, plus any open question or revisit condition).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-sqlite-instead-of-mongodb.md) | SQLite with WAL instead of MongoDB | Superseded by 0009 |
| [0002](0002-in-memory-cache-instead-of-redis.md) | In-memory cache instead of Redis | Accepted (the cache half stands) |
| [0003](0003-layered-architecture.md) | Layered architecture with ports and adapters | Accepted |
| [0004](0004-health-server-instead-of-express.md) | A hand-written health server instead of Express | Accepted |
| [0005](0005-single-container-deployment.md) | Single-container deployment | Accepted |
| [0006](0006-aes-gcm-for-stored-passwords.md) | AES-256-GCM for stored passwords | Accepted |
| [0007](0007-centralized-persian-copy.md) | Centralised Persian copy | Accepted |
| [0008](0008-acknowledge-before-processing.md) | Acknowledge webhook deliveries before processing them | Accepted |
| [0009](0009-redis-for-all-storage.md) | Redis for all storage, instead of SQLite | Accepted |

## Adding a record

1. Take the next number and name the file `<number>-<short-slug>.md`.
2. Keep the section order above, and keep the reasoning in it — a record that
   states only the decision is a note, not a decision record.
3. Record the options that were rejected and why. That is the part future readers
   actually need.
4. Add the row to the table above.
