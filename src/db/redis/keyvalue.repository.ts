import type Redis from 'ioredis';
import type { FeatureKey, FeatureState } from '../../domain/features';
import type { FeatureRepository, SettingsRepository } from '../../domain/ports';
import { scanKeys, type RedisStore } from './store';

/**
 * Which capabilities an operator has switched off.
 *
 * Absence of a key means "on", exactly as a missing row did: a feature that has
 * never been touched is enabled, which is what makes adding one a code change
 * with no backfill.
 */
export class RedisFeatureRepository implements FeatureRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async all(): Promise<readonly FeatureState[]> {
    const keys = await scanKeys(this.client, this.store.featurePattern());

    if (keys.length === 0) {
      return [];
    }

    const values = await this.client.mget(keys);
    const stem = this.store.featureKeyPrefix();

    return keys
      .map((key, index) => ({ key: key.slice(stem.length) as FeatureKey, enabled: values[index] === '1' }))
      .filter(state => state.key.length > 0);
  }

  async set(key: FeatureKey, enabled: boolean): Promise<void> {
    await this.client.set(this.store.feature(key), enabled ? '1' : '0');
  }
}

/**
 * Operator settings that outlive the process.
 *
 * A missing key means "never set", and every reader turns that into its own
 * default — so the stored value is an override rather than the source of truth.
 */
export class RedisSettingsRepository implements SettingsRepository {
  constructor(
    private readonly store: RedisStore,
    private readonly client: Redis,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(this.store.setting(key));
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(this.store.setting(key), value);
  }

  async remove(key: string): Promise<void> {
    await this.client.del(this.store.setting(key));
  }
}
