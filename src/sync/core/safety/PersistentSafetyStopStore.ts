import type { LocalDataStore } from '../../../platform/storage';
import type { SyncErrorCode } from '../../errors';

const STORAGE_KEY = 'deardiary_sync_safety_stops';

export interface PersistentSafetyStop {
  accountId: string;
  errorCode: SyncErrorCode;
  diagnosticCode: string;
  engagedAt: number;
}

export class PersistentSafetyStopStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LocalDataStore,
    private readonly now: () => number = Date.now,
  ) {}

  get(accountId: string): Promise<PersistentSafetyStop | null> {
    return this.exclusive(async () => (await this.read())[accountId] || null);
  }

  engage(
    accountId: string,
    errorCode: SyncErrorCode,
    diagnosticCode: string,
  ): Promise<PersistentSafetyStop> {
    return this.exclusive(async () => {
      const stops = await this.read();
      const existing = stops[accountId];
      if (existing) return existing;
      const stop = { accountId, errorCode, diagnosticCode, engagedAt: this.now() };
      stops[accountId] = stop;
      await this.store.setItem(STORAGE_KEY, JSON.stringify(stops));
      return stop;
    });
  }

  clearAfterVerifiedRecovery(accountId: string): Promise<void> {
    return this.exclusive(async () => {
      const stops = await this.read();
      delete stops[accountId];
      await this.store.setItem(STORAGE_KEY, JSON.stringify(stops));
    });
  }

  /**
   * Older clients persisted an unclassified pull failure as a permanent safety
   * stop. Unlike an integrity, schema, or key failure, UNKNOWN contains no
   * evidence that local data is unsafe. Clear only that exact recoverable marker so
   * the runtime can perform a fresh pull before enabling uploads.
   */
  clearRecoverableUnknownPull(accountId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const stops = await this.read();
      const stop = stops[accountId];
      if (stop?.errorCode !== 'UNKNOWN' || stop.diagnosticCode !== 'pull:UNKNOWN') return false;
      delete stops[accountId];
      await this.store.setItem(STORAGE_KEY, JSON.stringify(stops));
      return true;
    });
  }

  async assertDestructiveActionAllowed(accountId: string): Promise<void> {
    if (await this.get(accountId))
      throw new Error('Destructive synchronization actions are disabled by safety stop.');
  }

  private async read(): Promise<Record<string, PersistentSafetyStop>> {
    const raw = await this.store.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PersistentSafetyStop>) : {};
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
