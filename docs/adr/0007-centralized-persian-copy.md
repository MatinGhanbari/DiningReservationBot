# 7. Centralised Persian copy

- **Status:** Accepted
- **Date:** 2026 (1405 AP)

## Context

In the previous version the strings lived in `constants/messages.ts`, but other
Persian strings were scattered alongside them: some inside `bot.controllers.ts`,
some in `utils/format.ts`, and in a few places Persian strings were written
directly inside the logic.

The consequences were:

- Making the tone consistent meant searching through several files.
- There was no way to find where a given string was used.
- Strings were written with the wrong half-space and with the Arabic «ي» and «ك».
- Errors had two narratives — an English technical message and a user message —
  and in practice the technical message was sometimes shown to the user.

## Decision

One file, `src/copy/fa.ts`, holding every user-facing string, and one hard rule:
**no Persian string is written outside it.**

The shape of the file:

```ts
export const copy = {
  start: { welcome: (name: string) => `…` },
  menu: { … },
  reservation: { … },
  forgetCode: { … },
  autoReserve: { … },
  errors: { … },
};
```

- Every entry is a **function**, even when it takes no parameters. That keeps the
  signatures uniform, and adding a parameter later will not change the call sites.
- Every interpolated value passes through `escapeHtml`.
- `FOOTER` is a standalone constant, not a function referring to `copy`, because
  otherwise the object's type would depend on itself.
- Errors also carry two narratives: a technical `message` for the log and a
  Persian `userMessage` for the user. The `AppError` base class holds both, and
  the presentation layer always shows the latter.

## Consequences

**Positive**

- One file is enough to review the whole bot's tone.
- Searching for a phrase shows every place it is used.
- The half-space, Persian digits, «guillemets» and the Persian ی/ک are applied
  consistently, in one place.
- A technical error never reaches the user; even an unforeseen error is
  translated into a Persian sentence in `reply.ts`.

**Negative**

- For one short string you have to open another file.
- `copy/fa.ts` is large. If it passes several hundred lines, splitting it into
  `copy/fa/` with one file per screen would be reasonable.

**Writing rules observed**

- Half-space in «می‌روم», «نمی‌شود», «کد‌ها».
- Persian digits in text, Latin digits in code.
- Persian «guillemets» instead of `"`.
- No em dash.
- A respectful conversational tone — «می‌تونی», «سر بزن» — neither stiffly formal
  nor rudely casual.

## Update

The catalog has since grown a keyed JSON form: `src/copy/locales/fa.json` holds the
texts, `src/copy/fa.ts` builds the composed messages on top of it, and
`src/copy/i18n.ts` resolves each key. The operator can override any string on disk
at `data/locales/fa.json` without a rebuild, and the bundled catalog is the
per-key fallback. The rule itself is unchanged: no Persian string is written
outside the catalog.
