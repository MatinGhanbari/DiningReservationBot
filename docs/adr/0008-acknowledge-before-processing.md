# 8. Acknowledge webhook deliveries before processing them

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

Telegraf's `webhookCallback` ends the HTTP response only once the whole
middleware chain has finished: `handleUpdate` awaits the chain and the response
is ended in its `finally`. That chain has a 90-second budget — `handlerTimeout`,
Telegraf's default, which this project does not override — so for up to that long
Telegram is holding a request open for a bot that is still working.

Two consequences, both seen in production:

- A delivery that is slow to process is slow to acknowledge, so Telegram's own
  timeout and retry logic is exposed to handler latency rather than to whether
  the bot can accept work.
- A handler that overruns the budget is killed, and it is killed *after* the
  platform has waited for it. The log then shows a `TimeoutError` with no way to
  tell which update it belonged to, while the update itself carries on running
  and answers minutes later — after the generic failure has already been sent.

Long polling never had this problem: it fetches an update and processes it with
no platform-side wait. Webhook mode was strictly worse for delivery latency.

## Decision

Separate the delivery path from the processing path. `src/bot/webhook.ts`
replaces `webhookCallback` and, for each delivery:

1. checks the `X-Telegram-Bot-Api-Secret-Token` header against
   `TELEGRAM_WEBHOOK_SECRET` (`403` when it does not match), and refuses a body
   that is not an update (`415`) or is past a 1 MiB cap (`413`);
2. reads and parses the body, then answers `200` immediately;
3. processes the update in the background with `bot.handleUpdate`, logging the
   update's identity and duration, and logging the failure if it throws.

The bot's own identity is fetched at boot (`botInfo`) instead of lazily inside
the first `handleUpdate`, so an update cannot be acknowledged and then lost to a
`getMe` failure.

Rejected alternatives:

- **Raise `handlerTimeout`.** Makes the wait longer rather than shorter, and
  Telegram still times the delivery out.
- **Lower `handlerTimeout`.** Kills work sooner while the platform still waits.
- **A queue and a worker.** A whole component, a second failure mode and new
  state, for a single-process bot that receives a handful of updates a second.

## Consequences

**Positive**

- Acknowledgement latency is independent of handler latency. Measured: `200` in
  44–58 ms while a handler ran for 30.5 s.
- Telegram never retries because a handler was slow, so an update is delivered
  once and processed once.
- Telegraf's `webhookReply` optimisation no longer applies — there is no open
  response to answer in — so every API call is a real request. That is also why
  the API tracing added in `2c10a0e` now sees calls it used to miss.

**Negative**

- `200` means "accepted", not "processed". Telegram does not redeliver an update
  whose handling failed, so the log is the only record of it. Failures are logged
  at `error` with the update id, its type, the chat and the duration, and a
  middleware that runs longer than 30 seconds logs a `warn` naming itself.
- Concurrency is no longer limited to one request at a time. In practice it is
  bounded by Telegram's `max_connections` (40 by default).
- In-flight updates are no longer held open by their connection, so a shutdown
  would close the database underneath them. `container.shutdown` drains them for
  three seconds first, then logs whatever is left.

**Security note**

The secret check is the only thing between the public port and forged updates, so
it happens before anything is parsed. An empty `TELEGRAM_WEBHOOK_SECRET` disables
it — the same trade-off Telegraf's own filter makes — and is logged as a warning
at boot. A platform that does not send the header at all shows up as
`rejected a delivery whose secret token did not match` with `presented: false`.
