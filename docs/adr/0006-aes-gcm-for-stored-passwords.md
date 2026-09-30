# 6. AES-256-GCM for the stored password

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

To make signing back in to Samad silent, the user's password has to be stored. A
one-way hash is not enough, because the original password has to be sent to Samad,
so two-way encryption is unavoidable.

The previous version used `aes-256-ctr`, with two serious problems:

1. **The initialisation vector was fixed.** That made encryption deterministic:
   two users with the same password produced the same ciphertext. Anyone who got
   hold of the database could tell which accounts shared a password, and break
   them all at once with a dictionary attack.
2. **The key was the raw environment string.** With no key derivation, the key's
   real entropy was bounded by the quality of the string the operator generated.

On top of that, CTR has no authentication tag: tampering with the ciphertext is
undetectable and could be turned into a changed password.

## Decision

AES-256-GCM, with a key derived through `scrypt` and a random initialisation
vector per record:

```
v1:<iv-base64>:<tag-base64>:<ciphertext-base64>
```

- The initialisation vector comes from `randomBytes(12)` on every encryption.
- `scrypt` with a fixed salt, because the key comes from an environment secret
  rather than from a user password.
- A 16-byte authentication tag, verified on decryption.
- A version prefix, so that if the algorithm ever changes, older records are
  identifiable and migratable.
- Sensitive values are compared with `timingSafeEqual`.

## Consequences

**Positive**

- Two users with the same password have completely different ciphertext.
- Tampering with the ciphertext raises an error on decryption, rather than
  producing a corrupt password.
- The version tag leaves the future migration path open.

**Negative**

- Every record is 28 bytes larger (vector + tag), and `scrypt` costs a little CPU
  per operation. That cost is paid only at sign-in, not on every message.
- Changing `ENCRYPTION_KEY` invalidates every stored password. This is warned
  about in `.env.example`.

**Still unsolved**

The encryption key lives in an environment variable. If an attacker obtains both
the database and the environment variables, the passwords are readable. The
correct replacement is a KMS or `Docker secrets`. For a university bot on a single
server that level of protection was not proportionate, but it should be revisited
if the project expands to several universities.

**Migration note**

Passwords stored in the previous format are unreadable. Since users can sign in
again, no migration was needed.

## Update (2026)

The password is no longer stored at all: [ADR 0010](0010-refresh-tokens-instead-of-stored-passwords.md)
replaces it with the refresh token Samad issues. Everything above still applies
unchanged — the same `SecretBox`, the same cipher, the same versioned format, and
the same reasoning for choosing it. Only the value being protected changed, so
this record keeps its place, and its consequences (including the `ENCRYPTION_KEY`
warning) refer to the refresh token from here on.
