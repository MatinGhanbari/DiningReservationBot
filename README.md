# University Dining Reservation Bot

A Telegram bot that reserves dining hall meals through **Samad**, the meal
management platform used by Iranian universities. It signs in with the student's
own Samad credentials, shows the reservable menu, books meals, reserves
automatically ahead of the daily rush, shares unused forget-codes between
students, and routes support messages to the operators.

> **Language.** The bot's user-facing copy is Persian (`fa`) and lives entirely
> in the copy catalog — see [ADR 0007](docs/adr/0007-centralized-persian-copy.md).
> All documentation and code comments are English, so the project is readable to
> anyone; the product itself is for Persian-speaking students.

This project is a complete rewrite of an earlier version: the code was split into
independent layers, Express was removed, and every user-facing string was rewritten
to follow Persian orthography rules.

Storage is Redis. It went MongoDB -> SQLite -> Redis: SQLite was chosen to avoid a
network hop on the path of every message, and Redis was adopted later for
durability and operational simplicity, at the cost of that hop. The reasoning, and
what it costs, is in [ADR 0009](docs/adr/0009-redis-for-all-storage.md).

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Environment variables](#environment-variables)
  - [Samad settings: `appsettings.json`](#samad-settings-appsettingsjson)
  - [Update delivery: webhook or long polling](#update-delivery-webhook-or-long-polling)
- [Operations](#operations)
- [Backup and restore](#backup-and-restore)
- [Development](#development)
- [Security](#security)
- [Architecture decision records](#architecture-decision-records)
- [Licence](#licence)

---

## Features

| Feature | Description |
| --- | --- |
| Sign in | Samad username and password, used once; the session is renewed with a stored refresh token |
| Browse the menu | Reservable meals, grouped by dining hall and by week |
| Reserve a meal | Confirmed booking, with the exact result reported back from Samad |
| Auto-reserve | Books the chosen weekdays ahead of capacity filling up |
| Forget-code sharing | Claim a code for today's meal, or donate your own to the shared pool |
| My details | Remaining credit, name and account details |
| Support | Sends a message to the operators from inside the bot |
| Support chatbot | Optional AI assistant that answers questions about using the bot |

---

## Architecture

Layered architecture with ports and adapters. Each layer depends only on the one
below it, and there are no global dependencies — everything is constructed in a
single place.

```
src/
├── domain/          entities and ports, no I/O
│   ├── models.ts        domain types
│   ├── ports.ts         repository and gateway contracts
│   └── universities.ts  university list, read from appsettings.json
│
├── app/             use cases, business logic
│   ├── session.service.ts       Samad token lifetime
│   ├── auth.service.ts          sign in and sign out
│   ├── reservation.service.ts   menu and booking
│   ├── forget-code.service.ts   forget-code pool
│   └── auto-reserve.service.ts  automatic reservation
│
├── db/redis/        Redis keyspace and the repositories
├── cache/           in-memory cache (sessions, conversation state)
├── crypto/          encryption of the stored refresh token
├── config/          configuration
│   ├── env.ts           environment variables, validated with zod
│   └── appsettings.json every Samad host, route and header
├── samad/           HTTP client and Samad response translation
│
├── bot/             presentation layer (Telegram)
│   ├── handlers/        one handler per screen
│   ├── keyboards.ts     keyboards and button labels
│   ├── callback-data.ts button payload encoding
│   ├── state.ts         conversation state
│   └── reply.ts         sending replies and translating errors to Persian
│
├── copy/fa.ts       every user-facing string, in one file
├── http/health.ts   health server
├── scheduler/       scheduler
├── container.ts     composition root, the only place a dependency is built
└── main.ts          entry point and graceful shutdown
```

**Why this structure.** Every layer can be tested on its own. `ForgetCodeService`
needs no Telegram, no network and no real Redis to be exercised — which was
impossible in the previous version, where services constructed each other inside
their own constructors and `AuthService` and `UserService` formed a dependency
cycle.

### The path of one request

```
Telegram message
  → bot/handlers        identify the screen, validate the input
  → app/*.service       make the business decision
  → app/session.service a fresh token, or the cached one
  → samad/gateway       translate domain ↔ Samad
  → samad/client        HTTP with a timeout and retries
```

---

## Requirements

- Node.js 22 or newer
- Docker and Docker Compose, for deployment
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Samad account, and the Samad client credential (see `SAMAD_BASIC_AUTH`)

---

## Quick start

```bash
cp .env.example .env
# Fill in BOT_TOKEN, ADMINS and ENCRYPTION_KEY
openssl rand -hex 48          # a value for ENCRYPTION_KEY
openssl rand -hex 32          # a value for REDIS_PASSWORD

docker compose up -d --build
docker compose logs -f bot
```

The bot should now answer on Telegram. Check the service:

```bash
curl http://127.0.0.1:3000/health   # the process is alive
curl http://127.0.0.1:3000/ready    # it is ready to do useful work
```

---

## Configuration

### Environment variables

Every variable is documented in [`.env.example`](.env.example). The ones that
matter most:

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_TOKEN` | — | **Required.** Bot token from @BotFather |
| `ADMINS` | — | **Required.** JSON array of numeric admin ids |
| `ENCRYPTION_KEY` | — | **Required.** At least 64 characters; encrypts the stored refresh tokens |
| `SAMAD_BASIC_AUTH` | empty | Samad client credential, `Basic <base64>`. Empty makes the Samad login fail with `401` |
| `REDIS_PASSWORD` | — | **Required by the compose file.** The Redis password. Compose feeds it to `redis-server --requirepass` *and* to the bot's `REDIS_URL`, so the two cannot drift. Generate with `openssl rand -hex 32` |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The Redis holding all of the data. Carry the password in the URL — `redis://:<password>@host:port` — and use `rediss://` for TLS |
| `REDIS_KEY_PREFIX` | `drb:` | Namespace for every key, if the Redis is shared |
| `DATA_DIR` | `./data` | Directory holding the operator-editable text catalog |
| `TELEGRAM_WEBHOOK_URL` | empty | Public HTTPS webhook address. Empty means long polling |
| `TELEGRAM_WEBHOOK_PATH` | empty | Local route to serve the webhook on, when a proxy rewrites the path. Empty means the URL's own path |
| `TELEGRAM_WEBHOOK_SECRET` | empty | Webhook secret, to reject forged requests |
| `AUTO_RESERVE_CRON` | `0 7 * * *` | Time of the daily auto-reserve run |
| `CREDIT_CHECK_CRON` | `0 20 * * *` | Time of the daily credit check |
| `TZ` | `Asia/Tehran` | Process time zone |
| `RESERVABLE_DAYS_AHEAD` | `3` | How many days ahead a meal becomes reservable |
| `PORT` | `3000` | Port for the health server and the webhook |
| `LOG_LEVEL` | `info` | `fatal` through `trace` |
| `LOG_PRETTY` | `false` | Human-readable logs, for development |
| `OPENROUTER_API_KEY` | empty | Enables the support chatbot. Empty hides it |
| `SAMAD_TIMEOUT_MS` | `15000` | Timeout for each request to Samad |
| `SAMAD_MAX_RETRIES` | `2` | Retries on a transient error |
| `SAMAD_TLS_VERIFY` | `true` | Verify Samad's TLS certificate chain |

> **Warning:** changing `ENCRYPTION_KEY` makes the stored refresh tokens
> unreadable, and every user has to sign in again.

### Samad settings: `appsettings.json`

Every host, route and header lives in one file:
[`src/config/appsettings.json`](src/config/appsettings.json). No other place in
the code builds a Samad path, so "the bot called the wrong endpoint" is a
one-line change rather than a search across the whole client and gateway.

| Section | What it holds |
| --- | --- |
| `headers` | Headers every Samad request carries |
| `client` | Public mobile client settings: `grantType`, `scope`, `selfType`, `app` |
| `routes` | The routes the bot actually calls |
| `reference` | The rest of the API surface, captured from the web client and the mobile bundle |
| `universities` | Id, name and `baseUrl` of each university |

The values were captured on 2026-09-21 from Samad release 3.2.0, out of the web
client (`samad.app`) and the mobile app's JavaScript bundle. `routes` is what the
bot uses today; `reference` records the remaining endpoints so the whole API
surface is visible in one file, without having to unpack the frontend bundle
again to find them.

Notes:

- The file is compiled into `dist` at build time, so changing a route requires a
  rebuild. That is deliberate: a wrong route that only shows up in production is
  worse than one that breaks the build.
- The file is validated with zod. If a route is removed from `routes`, or a
  `baseUrl` is invalid, the process stops the moment it starts — not when the
  first user taps a button.
- To add a university, add an object to `universities`. Ids must be unique; a
  duplicate stops the process from starting.
- Parameterised routes are written with `{placeholder}` and built with
  `samadRoute()`. If a value is missing, the function throws, and a request
  containing a raw `{programId}` is never sent to Samad.
- The client credential is **not** here. It is a secret, so it lives in
  `SAMAD_BASIC_AUTH`; the settings file carries only the placeholder shape.

### Update delivery: webhook or long polling

The bot picks one of two modes by itself, depending on the environment:

| Environment | Condition | Mode |
| --- | --- | --- |
| `production` | `TELEGRAM_WEBHOOK_URL` is set | **Webhook.** The address is registered with Telegram, which delivers updates to that path. |
| Any other environment, or production without an address | — | **Long polling.** Any existing webhook is deleted so it cannot conflict with polling. |

The practical consequence is that working on your own machine needs no tunnel and
no public address: `NODE_ENV=development` is enough. If you start the bot locally
against the same bot that production uses, the webhook is deleted and polling
takes over.

In webhook mode, the same HTTP server that answers `/health` and `/ready` also
receives Telegram's requests, so only one port is needed. Telegram accepts only
ports `443`, `80`, `88` and `8443`. The webhook path is the path of the URL, so
`https://bot.example.com/telegram/webhook` is answered on `/telegram/webhook`.

Deliveries are **acknowledged before they are processed**. The body is read, the
secret is checked, and `200` goes back immediately; the update is then handled in
the background, so Telegram never waits for a handler and a handler that runs
past Telegraf's 90-second budget can no longer make the platform time out or
retry. The reasoning, and what it costs, is in
[ADR 0008](docs/adr/0008-acknowledge-before-processing.md).

The cost is that `200` means "accepted", not "processed": Telegram does not
redeliver an update whose handling failed, so the log is the only record of it.
Every update is traced — arrival, each API call and its response, at
`LOG_LEVEL=debug` — and the lines that matter at the default level are the
failures: `update could not be processed`, `unhandled bot error` (with the update
id, its type and the chat), and `middleware is slower than expected`, which names
the middleware behind a timeout.

That holds while the proxy forwards the path unchanged. A gateway that **strips a
prefix** — one that answers `https://host/api/<id>/…` by forwarding `…` — hands
the bot `/` instead, and the delivery lands on a route nothing serves. The
symptom is a `405 Method Not Allowed` in `getWebhookInfo`, because a `POST` to an
unmatched path is what the server rejects with. Set `TELEGRAM_WEBHOOK_PATH` to
the path that actually arrives; Telegram keeps posting to the URL's own path and
only the local route changes:

```env
TELEGRAM_WEBHOOK_URL=https://host/api/<id>/
TELEGRAM_WEBHOOK_PATH=/
```

To tell which kind of proxy you are behind, ask it for a route whose answer is
unmistakable and read the body — if `/api/<id>/health` returns the bot's own
`{"status":"ok","uptimeSeconds":…}`, the prefix is being stripped.

```env
NODE_ENV=production
PORT=80
TELEGRAM_WEBHOOK_URL=https://bot.example.com/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
```

> **Security:** in webhook mode the port has to be reachable from outside, and
> `/health` and `/ready` have no authentication and report the number of users
> and active sessions. Put the service behind a TLS reverse proxy that forwards
> only the webhook path, and always set `TELEGRAM_WEBHOOK_SECRET` so that a
> request without the `X-Telegram-Bot-Api-Secret-Token` header is rejected.
> A proxy configured for a whole prefix rather than a single path forwards
> `/health` and `/ready` too — check `GET <prefix>/ready` from the public
> internet, and if it answers, the service is reporting its user count to
> anyone who asks.
>
> If a platform never sends that header, every delivery is refused with `403`
> and the log says `rejected a delivery whose secret token did not match` with
> `presented: false` — that is the signal to leave `TELEGRAM_WEBHOOK_SECRET`
> empty rather than to hunt for a proxy bug.

---

## Operations

### Health endpoints

| Route | Meaning |
| --- | --- |
| `GET /health` | Liveness. Always `200` while the process is up |
| `GET /ready` | Readiness. Runs a real Redis query, and answers `503` on failure |

The distinction matters: a process whose Redis is unreachable is still "alive" but
cannot do useful work.

The port is published on `127.0.0.1` only, because this service has no
authentication and exposing it on `0.0.0.0` would make the user count and the
active session count readable by anyone.

### Logs

Logs are structured (JSON) and go to stdout. Passwords, tokens and the
`authorization` header are stripped centrally and never reach the log.

```bash
docker compose logs -f bot
docker compose logs bot | grep '"level":50'    # errors only
```

### Updating

```bash
git pull
docker compose up -d --build
```

There are no migrations: Redis has no schema to create, so the keyspace is defined
entirely by `src/db/redis/store.ts`, which is the only place that names a key. The
admin panel still reports a schema version, and it is a number an operator bumps by
hand when a keyspace change needs action from them.

### Rolling back

```bash
git checkout <commit>
docker compose up -d --build
```

The keyspace is forward-only and additive, so a newer version stays compatible
with older keys. A change that removes a structure is the one case that needs a
migration note.

### Shutdown

The container gets up to 8 seconds on `SIGTERM`: the scheduler stops, the bot and
the health server close, in-flight updates are drained, and the Redis connection is
closed. Nothing is flushed — Redis owns its own persistence, and the AOF is written
as commands arrive rather than at shutdown.

---

## Backup and restore

The data lives in the `redis-data` volume, and the container writes an
append-only file into it. There are two ways to take a copy.

**The whole server, from the host.** This is the one to use for a real backup:

```bash
docker compose exec redis redis-cli BGSAVE
docker compose cp redis:/data/appendonlydir ./backup-$(date +%F)
```

`redis-cli` authenticates on its own: the compose file sets `REDISCLI_AUTH` on the
`redis` service from `REDIS_PASSWORD`, so no command above needs an `-a` flag and
the password never appears in an argument list or a shell history.

**The keyspace, from the bot.** The admin panel's "backup" button walks every key
and dumps each value, and sends the result to the admin who asked. It is slower,
but it needs no access to the Redis filesystem and it is a file a human can read:

```bash
docker compose exec bot node -e "
  const { RedisStore } = require('./dist/db/redis/store');
  const store = new RedisStore({ url: process.env.REDIS_URL, prefix: process.env.REDIS_KEY_PREFIX });
  store.snapshot('/tmp/backup.json').then(() => store.close());
"
docker compose cp bot:/tmp/backup.json ./backup-$(date +%F).json
```

That file restores with `RESTORE <key> 0 <base64-decoded value>`, one line per key,
because the values are Redis' own serialised form.

---

## Development

```bash
npm ci
cp .env.example .env

npm run dev          # run with reload
npm run typecheck    # type checking
npm test             # test suite
npm run lint         # ESLint
npm run format       # Prettier
```

A Redis is required: for development to run the bot, and for the test suite to
pass. The compose file's service is the easiest one to borrow:

```bash
docker compose up -d redis
```

The suite talks to a real server, because the repositories are Redis commands and
Lua scripts rather than a query language — a mock would only be testing the mock.
It runs against `redis://127.0.0.1:6379` by default and takes `TEST_REDIS_URL` to
point somewhere else. Each test writes under its own random key prefix, so two
test files running side by side cannot delete each other's data.

For local runs, set `REDIS_URL` if your Redis is not on the default port, and set
`LOG_PRETTY=true` for readable logs. If that Redis asks for a password, carry it in
the URL — `redis://:<password>@127.0.0.1:6379` — and point the suite at the same
place with `TEST_REDIS_URL`, which defaults to `redis://127.0.0.1:6379` and knows
nothing about `REDIS_PASSWORD`. The compose service is password-protected and not
published to the host, so a test run cannot borrow it as-is.

### Testing

The suite runs on Vitest. Each test writes under its own key prefix on a real
Redis, so no test can affect another and none of them flushes a shared database.
Both time and the network are simulated: no test connects to Samad or to Telegram.

Coverage: encryption, the keyspace and repositories, Samad response translation,
token lifetime, auto-reserve, the forget-code pool, the Persian copy helpers, the
health server and button payload encoding.

### Conventions

- **No secrets, and no deployment fingerprint, in the repository.** No keys, no
  tokens, no passwords, no server address, hostname, port, deploy path or admin
  identity. `.env` is the only place a real value lives.
- **Never write a Persian string outside the copy catalog.** See
  [ADR 0007](docs/adr/0007-centralized-persian-copy.md).
- **No module builds its own dependency.** If you find a `new` for an adapter
  that is not in `container.ts`, that is a bug.

---

## Security

- **Passwords are never stored.** Signing in uses the password once, and what is
  kept afterwards is the refresh token Samad issues in return — encrypted with
  AES-256-GCM under a key derived with `scrypt`, with a random initialisation
  vector per record, in a versioned format. The refresh token can be revoked and
  expires; a password could not be. See
  [ADR 0010](docs/adr/0010-refresh-tokens-instead-of-stored-passwords.md) and
  [ADR 0006](docs/adr/0006-aes-gcm-for-stored-passwords.md) for the cipher.
- **Secrets** are read from the environment only. `appsettings.json` is tracked
  by git and therefore holds no credential — a value committed once stays
  readable in the history even after it is deleted from the file.
- **Redis** requires a password, even though the compose file publishes no port
  for it. A password is the difference between "reachable from the compose
  network" and "readable and wipeable by anything that reaches that network",
  and the whole dataset lives there. `REDIS_PASSWORD` reaches the server through
  `--requirepass` and the bot through `REDIS_URL`, from one value.
- **The container** runs as a non-root user, with a read-only filesystem and
  `no-new-privileges`.
- **The support chatbot** is constrained twice over: the system prompt forbids
  disclosing hosts, paths, configuration or statistics, and the answer is checked
  before it is sent, so a model that ignores the prompt still cannot leak.
- **CI** scans the full git history for secrets, audits dependencies, and scans
  the built image before anything is published.

To report a vulnerability, please open a private security advisory rather than a
public issue.

---

## Architecture decision records

The significant decisions and the reasoning behind each are recorded in
[`docs/adr/`](docs/adr):

| # | Decision |
| --- | --- |
| [0001](docs/adr/0001-sqlite-instead-of-mongodb.md) | SQLite with WAL instead of MongoDB |
| [0002](docs/adr/0002-in-memory-cache-instead-of-redis.md) | In-memory cache instead of Redis |
| [0003](docs/adr/0003-layered-architecture.md) | Layered architecture with ports and adapters |
| [0004](docs/adr/0004-health-server-instead-of-express.md) | A hand-written health server instead of Express |
| [0005](docs/adr/0005-single-container-deployment.md) | Single-container deployment |
| [0006](docs/adr/0006-aes-gcm-for-stored-passwords.md) | AES-256-GCM for stored passwords |
| [0007](docs/adr/0007-centralized-persian-copy.md) | Centralised Persian copy in one file |
| [0010](docs/adr/0010-refresh-tokens-instead-of-stored-passwords.md) | Refresh tokens instead of stored passwords |

---

## Licence

[MIT](LICENSE)
