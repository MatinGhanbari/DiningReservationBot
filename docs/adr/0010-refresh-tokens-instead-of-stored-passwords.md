# 10. Refresh tokens instead of stored passwords

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

Silent renewal used to require the user's password: it was encrypted and replayed
to Samad whenever the access token lapsed (ADR 0006, which chose the cipher for
exactly that). The encryption was sound; the problem was the choice of secret.
A password is not scoped to this bot. It opens the user's whole Samad account, and
for most students it is the national ID number — a value that is neither secret in
practice nor changeable by choice. Anyone who obtained both the Redis dump and
`ENCRYPTION_KEY` held every user's account, not just a session.

Samad's token endpoint is a standard OAuth 2.0 password grant and answers with a
`refresh_token` alongside the access token. That is verifiable without a live
login, from the deployed web client: on a `401` from any endpoint except
`/oauth/token` itself, `samad.app` posts

```
grant_type=refresh_token&refresh_token=<token>
```

to `/oauth/token` with the same `Basic` client credential and no other parameter,
then retries the original request. When that call fails it clears both stored
tokens and navigates to `/login` — a refresh token it cannot renew is a dead end
for the client too, not something it can work around.

## Decision

The password is used once, at sign-in, and is never written anywhere. What is
stored is the refresh token, encrypted with the same `SecretBox` (ADR 0006
stands, unchanged, for how a stored secret is protected).

- `User.encryptedRefreshToken` replaces `User.encryptedPassword`, in the same
  record and under the same key.
- The access token stays in the in-memory session cache with its expiry. A read
  that finds it stale, or within five minutes of lapsing, trades the refresh token
  for a new one — renewal is lazy, at the point of use, so no scheduled job has to
  guess when a token will die.
- A renewal that cannot happen — nothing stored, a ciphertext that does not
  decrypt, or a `401` from Samad — becomes the existing session-expired path. The
  user is asked to sign in again, which also re-encrypts under the current key.
- `خروج` (logout) deletes the record, so the refresh token goes with it.
- If Samad returns a rotated refresh token, the new one is written back. The
  captured client ignores it and keeps the one it has, so this is belt and braces
  rather than a known requirement.

## Consequences

**Positive**

- The bot no longer stores anything that opens an account somewhere else. What it
  holds is a credential Samad granted, that Samad can revoke, and that lapses.
- A stolen Redis dump is no longer a list of passwords.
- No migration: a record with no stored token is a user who signs in once more.

**Negative**

- A deployment whose token endpoint issues no refresh token loses silent renewal:
  the session then lasts one access-token lifetime (Samad reports about an hour),
  and the 07:00 auto-reserve run would need a sign-in. The captured token response
  contains `refresh_token`, so this is not expected in practice — but it has not
  been confirmed against a live login, and it is the one thing to check on the
  first deployment.
- The refresh token's own lifetime is not exposed and cannot be extended from
  here. When it lapses the user signs in again. The captured client treats it as
  long-lived: it persists it in browser storage across sessions.

**Rejected**

- *Encrypting the password more strongly.* The cipher was never the weak part.
- *Storing only the access token.* It expires within the hour, and without a
  password or a refresh token there is no way back in at all.
- *Asking for the password again whenever the session lapses, while keeping a copy
  anyway.* The same exposure, with more friction on top of it.

**Revisit if**

Samad stops issuing refresh tokens, or the token turns out to live for less than
the access token. The fallback is a reminder before the auto-reserve run asking
the user to sign in, not a return to storing passwords.
