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

This project is a complete rewrite of an earlier version: the database moved from
MongoDB to SQLite, Redis and Express were removed, the code was split into
independent layers, and every user-facing string was rewritten to follow Persian
orthography rules.

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
| Sign in | Samad username and password; the password is stored encrypted with AES-256-GCM |
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
├── db/              SQLite and the repositories
├── cache/           in-memory cache (sessions, conversation state)
├── crypto/          password encryption
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
needs no Telegram, no network and no real database to be exercised — which was
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
| `ENCRYPTION_KEY` | — | **Required.** At least 64 characters; encrypts user passwords |
| `SAMAD_BASIC_AUTH` | empty | Samad client credential, `Basic <base64>`. Empty makes the Samad login fail with `401` |
| `DATABASE_PATH` | `./data/bot.db` | SQLite file path |
| `TELEGRAM_WEBHOOK_URL` | empty | Public HTTPS webhook address. Empty means long polling |
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

> **Warning:** changing `ENCRYPTION_KEY` makes previously stored passwords
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

---

## Operations

### Health endpoints

| Route | Meaning |
| --- | --- |
| `GET /health` | Liveness. Always `200` while the process is up |
| `GET /ready` | Readiness. Runs a real database query, and answers `503` on failure |

The distinction matters: a process whose database has been removed from under it
is still "alive" but cannot do useful work.

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

Database migrations run automatically at start-up. Each migration runs in a
transaction tagged with its version number, so a half-applied migration cannot be
left behind.

### Rolling back

```bash
git checkout <commit>
docker compose up -d --build
```

Migrations are forward-only and never destructive, so a newer schema stays
compatible with older code.

### Shutdown

The container gets up to 8 seconds on `SIGTERM`: the scheduler stops, the bot and
the health server close, and a final WAL checkpoint runs before the database is
closed, so the next start-up does not have to replay the log.

---

## Backup and restore

The database is SQLite, so a backup is a file copy — but a plain copy can be
inconsistent while WAL is active. Use `VACUUM INTO`, which produces a consistent,
compacted copy:

```bash
docker compose exec bot node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH, { readonly: true });
  db.exec(\"VACUUM INTO '/app/data/backup.db'\");
  db.close();
"
docker compose cp bot:/app/data/backup.db ./backup-$(date +%F).db
```

A consistent copy can be taken while the bot is running, because `VACUUM INTO`
only reads. The `bot-data` volume can be backed up directly as well, but
restoring it requires stopping the container.

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

For local runs, point `DATABASE_PATH` at a local path (the default is
`./data/bot.db`) and set `LOG_PRETTY=true` for readable logs.

### Testing

The suite runs on Vitest, and every test builds its own in-memory database, so no
test can affect another. Both time and the network are simulated: no test
connects to Samad or to Telegram.

Coverage: encryption, migrations and repositories, Samad response translation,
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

- **Passwords** are encrypted with AES-256-GCM under a key derived with `scrypt`,
  with a random initialisation vector per record. The stored format is versioned
  so the algorithm can be migrated later. See
  [ADR 0006](docs/adr/0006-aes-gcm-for-stored-passwords.md).
- **Secrets** are read from the environment only. `appsettings.json` is tracked
  by git and therefore holds no credential — a value committed once stays
  readable in the history even after it is deleted from the file.
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

---

## Licence

[MIT](LICENSE)
