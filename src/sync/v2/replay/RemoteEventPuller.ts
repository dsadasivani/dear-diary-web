import { SyncError, isSyncError } from '../../errors';
import type { SyncHealthStore } from '../../health/SyncHealthService';
import type { SyncV2ApiClient } from '../api/SyncV2ApiClient';
import type { SyncV2RemoteEvent } from '../api/SyncV2ApiTypes';
import type { SyncInvariantValidator } from '../domain/SyncInvariantValidator';
import type { PersistentSafetyStopStore } from '../safety/PersistentSafetyStopStore';
import type { BoundedObjectTransfer } from '../operation/BoundedObjectTransfer';
import type { DecryptedSyncV2Event, SyncV2ReplayStore } from './PersistentReplayStore';

export interface SyncV2EventDecryptor {
  hasKeyEpoch(keyEpoch: number): Promise<boolean>;
  decrypt(bytes: Uint8Array, keyEpoch: number): Promise<DecryptedSyncV2Event>;
}

export interface RemoteEventPullerOptions {
  accountId: string;
  deviceId: string;
  eventSchemaVersion: number;
  pageSize?: number;
  replayBatchSize?: number;
  now?: () => number;
}

export class RemoteEventPuller {
  private readonly pageSize: number;
  private readonly replayBatchSize: number;
  private readonly now: () => number;

  constructor(
    private readonly api: Pick<SyncV2ApiClient, 'pullEvents' | 'acknowledgeCursor'>,
    private readonly transfer: BoundedObjectTransfer,
    private readonly decryptor: SyncV2EventDecryptor,
    private readonly replay: SyncV2ReplayStore,
    private readonly validator: SyncInvariantValidator,
    private readonly safetyStop: PersistentSafetyStopStore,
    private readonly health: SyncHealthStore,
    private readonly options: RemoteEventPullerOptions,
  ) {
    this.pageSize = Math.min(100, Math.max(1, options.pageSize || 100));
    this.replayBatchSize = Math.min(this.pageSize, Math.max(1, options.replayBatchSize || 25));
    this.now = options.now || Date.now;
  }

  async pull(): Promise<number> {
    if (await this.safetyStop.get(this.options.accountId)) {
      throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
    }
    await this.health.updateSyncHealth({ lastPullAttemptAt: this.now() });
    try {
      let after = await this.replay.getLastAppliedSequence();
      while (true) {
        const page = await this.api.pullEvents(after, this.pageSize);
        this.validator.validateSequences(after, page.currentSequence);
        this.validator.validateReplayPage(page.events, after);
        for (let index = 0; index < page.events.length; index += this.replayBatchSize) {
          const envelopes = page.events.slice(index, index + this.replayBatchSize);
          const bytes = await this.transfer.download(envelopes);
          const decoded = await Promise.all(envelopes.map(async (event, eventIndex) => {
            this.validateEnvelope(event);
            if (!await this.decryptor.hasKeyEpoch(event.keyEpoch)) {
              throw new SyncError({ code: 'KEY_EPOCH_UNAVAILABLE', safetyRelevant: true });
            }
            return { envelope: event, event: await this.decryptor.decrypt(bytes[eventIndex], event.keyEpoch) };
          }));
          after = await this.replay.applyBatch(decoded);
          await this.api.acknowledgeCursor(this.options.deviceId, after);
        }
        if (page.events.length === 0) await this.api.acknowledgeCursor(this.options.deviceId, after);
        if (!page.hasMore) break;
        if (page.events.length === 0) throw new SyncError({ code: 'SEQUENCE_GAP', safetyRelevant: true });
      }
      await this.health.updateSyncHealth({
        localSequence: after,
        lastSuccessfulPullAt: this.now(),
        integrityState: 'HEALTHY',
      });
      return after;
    } catch (error) {
      const typed = isSyncError(error)
        ? error
        : new SyncError({ code: 'UNKNOWN', safetyRelevant: true, cause: error });
      if (typed.safetyRelevant) {
        await this.safetyStop.engage(this.options.accountId, typed.code, `pull:${typed.code}`);
      }
      await this.health.updateSyncHealth({
        integrityState: typed.safetyRelevant ? 'SAFETY_STOP' : 'WARNING',
        lastErrorCode: typed.code,
        lastErrorAt: this.now(),
      });
      throw typed;
    }
  }

  private validateEnvelope(event: SyncV2RemoteEvent): void {
    if (event.eventSchemaVersion !== this.options.eventSchemaVersion) {
      throw new SyncError({ code: 'SCHEMA_INCOMPATIBLE', safetyRelevant: true });
    }
  }
}
