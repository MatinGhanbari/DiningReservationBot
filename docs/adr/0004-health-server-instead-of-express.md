# 4. A hand-written health server instead of Express

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

The previous version had Express, along with Swagger, CORS, helmet, compression,
hpp and morgan. In practice **no route was implemented**, and the only thing that
answered was `GET /`, returning `200`.

That is eight dependencies, a routing layer and a documentation surface, purely
to keep the process alive. Every one of them needs security updates, and Swagger
is an extra attack surface that no user ever touched.

## Decision

A `node:http` server with no dependencies at all, exposing two routes:

| Route | Role | Response |
| --- | --- | --- |
| `GET /health` | liveness | Always `200` while the process is up |
| `GET /ready` | readiness | A real database query; `503` on failure |

```ts
this.server = createServer((request, response) => {
  this.handle(request, response).catch(error => {
    this.respond(response, 500, { status: 'error' });
  });
});
```

The split between the two is deliberate: a process whose database file has been
removed from under it is still "alive" but cannot do useful work. `/ready` detects
that with a real query (`SELECT COUNT(*)`), not by asking whether the handle is
open.

## Consequences

**Positive**

- Eight dependencies and the whole Swagger surface are gone.
- There is no middleware to configure or update.
- `/ready` is a real check, so an orchestrator takes a half-dead container out of
  the traffic rotation.

**Negative**

- If a real API is ever needed, it has to be added by hand. With `node:http` that
  is a few lines, but you write the routing and the body validation yourself. At
  that point, adding a framework is the right decision; today it is not.

**Security note**

The port is published on `127.0.0.1` only. This service has no authentication, and
`/ready` reports the number of users and active sessions, which is operational
information and should not be public.

**Update**

The webhook route added later was built the same way: a few lines on this same
`node:http` server, still with no framework. See the update-delivery section of
the [README](../../README.md#update-delivery-webhook-or-long-polling).
