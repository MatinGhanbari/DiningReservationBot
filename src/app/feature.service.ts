import { FEATURE_KEYS, type FeatureKey, type FeatureState } from '../domain/features';
import type { FeatureRepository } from '../domain/ports';
import { scopedLogger } from '../shared/logger';

const log = scopedLogger('features');

export class FeatureService {
  private cached: Map<FeatureKey, boolean> | null = null;

  constructor(private readonly repository: FeatureRepository) {}

  private async snapshot(): Promise<Map<FeatureKey, boolean>> {
    if (this.cached !== null) {
      return this.cached;
    }

    const stored = new Map<FeatureKey, boolean>();

    for (const state of await this.repository.all()) {
      stored.set(state.key, state.enabled);
    }

    const resolved = new Map<FeatureKey, boolean>();

    for (const key of FEATURE_KEYS) {
      resolved.set(key, stored.get(key) ?? true);
    }

    this.cached = resolved;

    return resolved;
  }

  async isEnabled(key: FeatureKey): Promise<boolean> {
    return (await this.snapshot()).get(key) ?? true;
  }

  async list(): Promise<readonly FeatureState[]> {
    const resolved = await this.snapshot();

    return FEATURE_KEYS.map(key => ({ key, enabled: resolved.get(key) ?? true }));
  }

  async setEnabled(key: FeatureKey, enabled: boolean): Promise<void> {
    await this.repository.set(key, enabled);
    this.cached = null;
    log.info({ feature: key, enabled }, 'feature toggled from the admin panel');
  }

  invalidate(): void {
    this.cached = null;
  }
}
