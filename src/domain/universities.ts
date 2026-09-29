import { samadSettings } from '../config/appsettings';

/**
 * Reference data for the universities this bot supports.
 *
 * The list itself lives in `appsettings.json` alongside the Samad routes, so a
 * new deployment is added in the same file as the endpoints it will be called
 * with. This module is the typed, indexed view of that data: callers keep asking
 * for a university by id or by the button label the user tapped, and never touch
 * the raw settings.
 */
export interface University {
  id: number;
  /** Name shown to the user when picking a university. */
  name: string;
  /** Short label used where space is tight, such as log lines. */
  shortName: string;
  baseUrl: string;
}

export const UNIVERSITIES: readonly University[] = Object.freeze(
  samadSettings.universities.map(university => Object.freeze({ ...university })),
);

const BY_ID = new Map<number, University>(UNIVERSITIES.map(university => [university.id, university]));

const BY_NAME = new Map<string, University>(UNIVERSITIES.map(university => [university.name, university]));

export function findUniversityById(id: number): University | undefined {
  return BY_ID.get(id);
}

/** Resolves a university from the exact button label the user tapped. */
export function findUniversityByName(name: string): University | undefined {
  return BY_NAME.get(name.trim());
}

export function isSupportedUniversityId(id: number): boolean {
  return BY_ID.has(id);
}
