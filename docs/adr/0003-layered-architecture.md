# 3. Layered architecture with ports and adapters

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

The previous version had a 489-line `bot.controllers.ts` holding all of the bot's
logic, and services that each constructed the next one inside their own
constructors. The result:

- `AuthService` depended on `UserService` and `UserService` depended on
  `AuthService`. Neither could be constructed, or tested, on its own.
- Business logic was tangled up with Telegram calls, so testing a rule without
  simulating Telegram was impossible.
- There was no boundary between "what decision was made" and "how it was told to
  the user".

## Decision

Four layers, each depending only on the one below it:

```
domain      entities and ports, no I/O
   ↑
app         use cases, using only the ports
   ↑
db / cache / crypto / samad      infrastructure adapters
   ↑
bot / http                        presentation layer
```

- `domain/ports.ts` defines the contracts: `UserRepository`,
  `ForgetCodeRepository`, `SessionStore`, `SamadGateway`, `TokenProvider`,
  `SecretBox`, `Clock`, `Notifier`.
- `container.ts` is the only place where implementations are constructed and
  wired together.
- `Clock` is injected as a port so that date-dependent logic is testable.

## Consequences

**Positive**

- The dependency cycle is gone: `AuthService` and `UserService` both depend on
  the repositories and on `SessionService`, not on each other.
- A use case can be exercised with no network and no real database. No test in
  the suite connects to Samad or to Telegram.
- Swapping an adapter is a local change: replacing the database means changing
  only the `db/` directory.

**Negative**

- There are more files, and a small change has to be followed through several
  layers.
- The explicit wiring in `container.ts` is long. That cost is deliberate:
  reading one file shows the entire dependency graph, unlike decorator-based
  auto-injection, which hides it.

**Rule that is kept**

No module is allowed to build its own dependency. If you find a `new` for an
adapter that is not in `container.ts`, that is a mistake.
