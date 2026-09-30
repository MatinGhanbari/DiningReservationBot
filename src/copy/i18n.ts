import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { config, isTest } from '../config/env';
import { scopedLogger } from '../shared/logger';
import { escapeHtml } from '../shared/persian';
import bundledFa from './locales/fa.json';

const log = scopedLogger('i18n');

const CatalogSchema = z.object({
  locale: z.string().min(1),
  version: z.number().int().positive(),
  messages: z.record(z.string(), z.unknown()),
});

type Catalog = z.infer<typeof CatalogSchema>;

const BUNDLED: Readonly<Record<string, Catalog>> = { fa: CatalogSchema.parse(bundledFa) };

const DEFAULT_LOCALE = 'fa';

export interface RawText {
  readonly text: string;
  readonly isRaw: true;
}

export const raw = (text: string): RawText => ({ text, isRaw: true });

export type TextParam = string | number | RawText;
export type TextParams = Readonly<Record<string, TextParam>>;

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export function localesDirectory(): string {
  const configured = config.LOCALES_DIR.trim();

  return configured.length > 0 ? resolve(configured) : join(resolve(config.DATA_DIR), 'locales');
}

export function catalogPath(locale: string): string {
  return join(localesDirectory(), `${locale}.json`);
}

function parseCatalog(source: string): Catalog | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    log.error({ err: error }, 'the text catalog is not valid JSON');
    return null;
  }

  const result = CatalogSchema.safeParse(parsed);

  if (!result.success) {
    log.error({ issues: result.error.issues.map(issue => issue.path.join('.') || 'root') }, 'the text catalog has an invalid shape');
    return null;
  }

  return result.data;
}

function readCatalog(filePath: string): Catalog | null {
  try {
    return parseCatalog(readFileSync(filePath, 'utf8'));
  } catch (error) {
    log.warn({ err: error, path: filePath }, 'could not read the text catalog');
    return null;
  }
}

function writeDefaultCatalog(filePath: string, catalog: Catalog): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    log.info({ path: filePath }, 'wrote the default text catalog; edit it to change bot texts without a rebuild');
  } catch (error) {
    log.warn({ err: error, path: filePath }, 'could not write the default text catalog');
  }
}

const requestedLocale = config.LOCALE.trim().length > 0 ? config.LOCALE.trim() : DEFAULT_LOCALE;
const bundled = BUNDLED[requestedLocale] ?? BUNDLED[DEFAULT_LOCALE];

if (bundled === undefined) {
  throw new Error(`No bundled text catalog for locale «${requestedLocale}».`);
}

export const locale: string = requestedLocale;
export const activeCatalogPath: string = catalogPath(requestedLocale);

const existedAtBoot = existsSync(activeCatalogPath);
const loaded = existedAtBoot ? readCatalog(activeCatalogPath) : null;

export const catalogSource: 'disk' | 'bundled' = loaded === null ? 'bundled' : 'disk';

if (loaded !== null) {
  log.info({ path: activeCatalogPath, locale, version: loaded.version }, 'using the editable text catalog from disk');
} else if (existedAtBoot) {
  log.warn({ path: activeCatalogPath }, 'the text catalog on disk could not be used; falling back to the bundled texts');
} else if (!isTest) {
  writeDefaultCatalog(activeCatalogPath, bundled);
}

const runtimeMessages: Record<string, unknown> = loaded?.messages ?? {};
const bundledMessages: Record<string, unknown> = bundled.messages;

function readPath(source: Record<string, unknown>, key: string): unknown {
  let current: unknown = source;

  for (const segment of key.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function lookup(key: string): string {
  const fromDisk = readPath(runtimeMessages, key);

  if (typeof fromDisk === 'string') {
    return fromDisk;
  }

  const fromBundle = readPath(bundledMessages, key);

  if (typeof fromBundle === 'string') {
    return fromBundle;
  }

  throw new Error(`Missing bot text for «${key}». Add it to ${activeCatalogPath}.`);
}

function interpolate(template: string, params: TextParams): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];

    if (value === undefined) {
      log.warn({ key: template.slice(0, 40), name }, 'a text placeholder has no matching value');
      return match;
    }

    return typeof value === 'object' ? value.text : escapeHtml(String(value));
  });
}

export function t(key: string, params?: TextParams): string {
  const template = lookup(key);

  return params === undefined ? template : interpolate(template, params);
}

export function hasText(key: string): boolean {
  return typeof readPath(runtimeMessages, key) === 'string' || typeof readPath(bundledMessages, key) === 'string';
}
