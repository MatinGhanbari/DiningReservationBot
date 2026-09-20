/**
 * Reference data for the universities this bot supports.
 *
 * Samad runs one deployment per university, so the numeric id both selects the
 * base URL and identifies the account namespace. Keeping the list in one place
 * means the bot and the upstream client can never disagree about which ids exist.
 */
export interface University {
  id: number;
  /** Name shown to the user when picking a university. */
  name: string;
  /** Short label used where space is tight, such as log lines. */
  shortName: string;
  baseUrl: string;
}

export const UNIVERSITIES: readonly University[] = [
  {
    id: 8,
    name: 'دانشگاه صنعتی خواجه نصیرالدین طوسی',
    shortName: 'خواجه نصیر',
    baseUrl: 'https://refahi.kntu.ac.ir',
  },
  {
    id: 3,
    name: 'دانشگاه شهید بهشتی',
    shortName: 'شهید بهشتی',
    baseUrl: 'https://dining.sbu.ac.ir',
  },
  {
    id: 6,
    name: 'دانشگاه صنعتی امیرکبیر',
    shortName: 'امیرکبیر',
    baseUrl: 'https://samad.aut.ac.ir',
  },
  {
    id: 7,
    name: 'دانشگاه صنعتی شریف',
    shortName: 'شریف',
    baseUrl: 'https://setad.dining.sharif.edu',
  },
] as const;

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
