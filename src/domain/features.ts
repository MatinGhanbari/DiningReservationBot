export const FEATURE_KEYS = [
  'reserve',
  'autoReserve',
  'reserves',
  'forgetCode',
  'profile',
  'about',
  'support',
  'chatbot',
  'samadSite',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

const FEATURE_KEY_SET: ReadonlySet<string> = new Set(FEATURE_KEYS);

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEY_SET.has(value);
}

export interface FeatureState {
  key: FeatureKey;
  enabled: boolean;
}

export const DEFAULT_FEATURE_STATE: FeatureState = { key: 'reserve', enabled: true };
