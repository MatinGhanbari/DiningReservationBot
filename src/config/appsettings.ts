import { z } from 'zod';
import rawSettings from './appsettings.json';

/**
 * The Samad integration settings, loaded once at boot.
 *
 * `appsettings.json` is the single place where a Samad URL, route path, header or
 * university host is written down. Nothing in `src/samad` builds a path itself,
 * which is what makes "the bot called the wrong endpoint" a one-line change
 * rather than a grep across the client and the gateway.
 *
 * The file is compiled into `dist` by the TypeScript build, so changing a route
 * is a rebuild, not a runtime edit — that is deliberate: a mistyped path that
 * only fails in production is worse than one that fails the build.
 */

/** A path relative to a university's base URL. */
const routePath = z.string().startsWith('/');

/** A path, or an absolute URL for the handful of endpoints outside a university host. */
const endpoint = z.string().regex(/^(https?:\/\/|\/)/, 'must be a path or an absolute URL');

/**
 * The routes the bot calls.
 *
 * Enumerated rather than a free-form record so that a route deleted from the JSON
 * is a boot failure instead of a `undefined` interpolated into a URL at 7am.
 */
const routesSchema = z.object({
  login: routePath,
  selfs: routePath,
  programs: routePath,
  reserves: routePath,
  reserve: routePath,
  profile: routePath,
  forgetCardCode: routePath,
});

const universitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  shortName: z.string().min(1),
  baseUrl: z.string().url(),
});

const settingsSchema = z.object({
  samad: z.object({
    release: z.string().min(1),
    origins: z.object({ web: z.string().url(), config: z.string().url() }),
    headers: z.record(z.string(), z.string()),
    client: z.object({
      grantType: z.string().min(1),
      /** The grant that renews a session from the refresh token, once the password is gone. */
      refreshGrantType: z.string().min(1),
      scope: z.string().min(1),
      basicAuth: z.string().min(1),
      selfType: z.string().min(1),
      app: z.string().min(1),
    }),
    routes: routesSchema,
    /**
     * The rest of the captured surface. Nothing reads these yet; they are here so
     * the whole API is documented in one file. Kept loose on purpose — a new
     * entry must not require a schema change.
     */
    reference: z.record(z.string(), endpoint),
    universities: z.array(universitySchema).min(1),
  }),
});

function readSettings(): z.infer<typeof settingsSchema>['samad'] {
  const result = settingsSchema.safeParse(rawSettings);

  if (!result.success) {
    const details = result.error.issues.map(issue => `  • ${issue.path.join('.')}: ${issue.message}`).join('\n');

    throw new Error(`appsettings.json نامعتبر است:\n${details}`);
  }

  const { samad } = result.data;

  const seenIds = new Set<number>();
  for (const university of samad.universities) {
    if (seenIds.has(university.id)) {
      throw new Error(`appsettings.json: شناسهٔ دانشگاه ${university.id} تکراری است.`);
    }
    seenIds.add(university.id);
  }

  return Object.freeze(samad);
}

export const samadSettings = readSettings();

/** A route the bot actually calls. */
export type SamadRouteName = keyof typeof samadSettings.routes;

/** A captured route recorded for reference; not called by the bot today. */
export type SamadReferenceRouteName = keyof typeof samadSettings.reference;

/**
 * Builds a route from the settings, filling `{placeholders}`.
 *
 * Throws when a placeholder is left without a value: a URL with a literal
 * `{programId}` in it would otherwise reach Samad and come back as a confusing
 * 404 that looks like an outage.
 */
export function samadRoute(name: SamadRouteName, params: Readonly<Record<string, string | number>> = {}): string {
  const template: string = samadSettings.routes[name];

  const expanded = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];

    if (value === undefined) {
      throw new Error(`مسیر «${name}» به مقدار ${key} نیاز دارد.`);
    }

    return encodeURIComponent(String(value));
  });

  const missing = expanded.match(/\{(\w+)\}/);

  if (missing !== null) {
    throw new Error(`مسیر «${name}» برای ${missing[1]} مقداری نگرفت.`);
  }

  return expanded;
}
