import type { SyncHealthPatch } from './SyncHealth';
import { SyncError } from '../errors';

export interface SyncHealthStore {
  updateSyncHealth(patch: SyncHealthPatch): Promise<unknown>;
}

export type SyncHealthOperation = 'PUSH' | 'PULL';

export class SyncHealthService {
  constructor(
    private readonly store: SyncHealthStore,
    private readonly now: () => number = Date.now,
  ) {}

  async track<T>(operation: SyncHealthOperation, task: () => Promise<T>): Promise<T> {
    await this.store.updateSyncHealth(operation === 'PUSH'
      ? { lastPushAttemptAt: this.now() }
      : { lastPullAttemptAt: this.now() });

    try {
      const result = await task();
      await this.store.updateSyncHealth(operation === 'PUSH'
        ? { lastSuccessfulPushAt: this.now() }
        : { lastSuccessfulPullAt: this.now() });
      return result;
    } catch (error) {
      const typed = error instanceof SyncError
        ? error
        : new SyncError({ code: 'UNKNOWN', cause: error });
      await this.store.updateSyncHealth({
        lastErrorCode: typed.code,
        lastErrorAt: this.now(),
        integrityState: typed.safetyRelevant ? 'SAFETY_STOP' : 'WARNING',
      });
      throw typed;
    }
  }
}
