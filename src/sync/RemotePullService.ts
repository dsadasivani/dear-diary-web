import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { GoogleAccountSession, LocalSyncAccountState, SyncObjectMetadata } from '../types';
import { measureAsync } from '../utils/performance';
import {
  CompanionKeyPackageError,
  decodeCompanionKeyPackage,
  unwrapRootKeysForCompanion,
} from './companionKeyPackage';
import { downloadVerifiedSyncObject, replaySyncObjects, type SyncObjectDownloader } from './eventReplay';
import { listPartitionKeysInSnapshot, recentPartitionKeys } from './syncPartitioning';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { type SyncSecrets, withAccountRootKeyForEpoch } from './syncSecrets';
import { emitSyncTelemetry } from './syncTelemetry';

export interface RemotePullRuntime {
  state: LocalSyncAccountState;
  secrets: SyncSecrets;
  googleSession: GoogleAccountSession;
  controlPlane: SupabaseControlPlaneClient;
}

interface RemotePullServiceDependencies {
  download?: SyncObjectDownloader;
  now?: () => number;
  loadSecrets: () => Promise<SyncSecrets | null>;
  saveSecrets: (secrets: SyncSecrets) => Promise<void>;
}

export class RemotePullService {
  private readonly download?: SyncObjectDownloader;
  private readonly now: () => number;

  constructor(
    private readonly repository: DiaryRepository,
    private readonly dependencies: RemotePullServiceDependencies,
  ) {
    this.download = dependencies.download;
    this.now = dependencies.now || Date.now;
  }

  pull(runtime: RemotePullRuntime): Promise<void> {
    return measureAsync('sync.pull.remote', () => this.pullUnlocked(runtime), {
      partitioned: Boolean(runtime.state.partitionedSyncEnabled),
    });
  }

  private async pullUnlocked(runtime: RemotePullRuntime): Promise<void> {
    let state = (await this.repository.getLocalSyncAccountState()) || runtime.state;
    if (state.partitionedSyncEnabled) {
      await this.pullPartitioned(runtime);
      return;
    }
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(state.deviceId, state.currentSyncSequence, 100);
      if (objects.length === 0) break;
      const processedKeyPackageSequence = await this.processKeyPackages(runtime, objects);
      state = await replaySyncObjects({
        repository: this.repository,
        localState: state,
        accountRootKey: runtime.secrets.accountRootKey,
        accountRootKeys: runtime.secrets.accountRootKeys,
        googleSession: runtime.googleSession,
        objects: objects.filter(object => object.objectKind !== 'key_package'),
      });
      if (processedKeyPackageSequence > state.currentSyncSequence) {
        state = {
          ...state,
          currentSyncSequence: processedKeyPackageSequence,
        };
        await this.repository.saveLocalSyncAccountState(state);
      }
      if (objects.length < 100) break;
    }
    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: state.currentSyncSequence,
    });
  }

  private pullPartitioned(runtime: RemotePullRuntime): Promise<void> {
    return measureAsync('sync.pull.partitioned', () => this.pullPartitionedUnlocked(runtime));
  }

  private async pullPartitionedUnlocked(runtime: RemotePullRuntime): Promise<void> {
    let state = (await this.repository.getLocalSyncAccountState()) || runtime.state;
    await this.pullGlobalKeyPackagesForPartitionedRuntime(runtime, state);
    state = (await this.repository.getLocalSyncAccountState()) || state;
    await this.registerRecentEventOnlyPartitions(runtime, state);
    const [coreState, archiveMonths] = await Promise.all([
      this.repository.getPartitionHydrationState('core'),
      this.repository.listAvailableArchiveMonths(),
    ]);
    const partitionStates = [coreState, ...archiveMonths]
      .filter(partition => partition.status === 'hydrated')
      .filter((partition, index, all) => (
        all.findIndex(candidate => candidate.partitionKey === partition.partitionKey) === index
      ));
    if (partitionStates.length === 0) {
      await runtime.controlPlane.updateDeviceCursor({
        deviceId: state.deviceId,
        lastAppliedSequence: state.currentSyncSequence,
      });
      return;
    }

    for (const partition of partitionStates) {
      let afterSequence = partition.lastAppliedSequence;
      while (true) {
        const objects = await runtime.controlPlane.listPartitionObjectsAfter(
          state.deviceId,
          partition.partitionKey,
          afterSequence,
          100,
        );
        if (objects.length === 0) break;
        const processedKeyPackageSequence = await this.processKeyPackages(runtime, objects);
        state = await replaySyncObjects({
          repository: this.repository,
          localState: state,
          accountRootKey: runtime.secrets.accountRootKey,
          accountRootKeys: runtime.secrets.accountRootKeys,
          googleSession: runtime.googleSession,
          objects: objects.filter(object => object.objectKind !== 'key_package'),
          download: this.download,
          allowHistorical: true,
        });
        if (processedKeyPackageSequence > state.currentSyncSequence) {
          state = {
            ...state,
            currentSyncSequence: processedKeyPackageSequence,
          };
          await this.repository.saveLocalSyncAccountState(state);
        }
        afterSequence = Math.max(afterSequence, ...objects.map(object => object.sequence));
        if (objects.length < 100) break;
      }
      if (afterSequence > partition.lastAppliedSequence) {
        await this.repository.markPartitionHydrated(partition.partitionKey, afterSequence);
        await runtime.controlPlane.updatePartitionCursor({
          deviceId: state.deviceId,
          partitionKey: partition.partitionKey,
          lastAppliedSequence: afterSequence,
          hydratedAt: new Date(this.now()).toISOString(),
        });
      }
      state = (await this.repository.getLocalSyncAccountState()) || state;
    }

    await runtime.controlPlane.updateDeviceCursor({
      deviceId: state.deviceId,
      lastAppliedSequence: state.currentSyncSequence,
    });
  }

  private async registerRecentEventOnlyPartitions(
    runtime: RemotePullRuntime,
    state: LocalSyncAccountState,
  ): Promise<void> {
    if (typeof runtime.controlPlane.listPartitionHeads !== 'function') return;

    const heads = await runtime.controlPlane.listPartitionHeads(state.deviceId);
    const recentKeys = new Set<string>(recentPartitionKeys(new Date(this.now())));
    const candidates = heads.filter(head => (
      recentKeys.has(head.partitionKey) &&
      head.latestEventSequence > 0 &&
      head.latestSnapshotSequence === 0
    ));
    if (candidates.length === 0) return;

    const localKeys = new Set<string>(listPartitionKeysInSnapshot(await this.repository.exportSnapshot()));
    for (const head of candidates) {
      const hydration = await this.repository.getPartitionHydrationState(head.partitionKey);
      if (hydration.status !== 'not_available') continue;

      // Older builds committed new-month events without recording the partition cursor.
      // Existing local records are already represented through the device's global cursor.
      const lastAppliedSequence = localKeys.has(head.partitionKey) ? state.currentSyncSequence : 0;
      await this.repository.markPartitionHydrated(head.partitionKey, lastAppliedSequence);
      await runtime.controlPlane.updatePartitionCursor({
        deviceId: state.deviceId,
        partitionKey: head.partitionKey,
        lastAppliedSequence,
        hydratedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  private async processKeyPackages(
    runtime: RemotePullRuntime,
    objects: SyncObjectMetadata[],
  ): Promise<number> {
    const keyPackages = objects
      .filter(object => object.objectKind === 'key_package')
      .sort((left, right) => left.sequence - right.sequence);
    if (keyPackages.length === 0) return 0;

    const hasAccountEpochLookup = typeof runtime.controlPlane.lookupCurrentGoogleAccount === 'function';
    const account = hasAccountEpochLookup
      ? await runtime.controlPlane.lookupCurrentGoogleAccount().catch(() => null)
      : null;
    const currentAccountEpoch = hasAccountEpochLookup
      ? account?.currentKeyEpoch || runtime.state.keyEpoch || 1
      : Number.MAX_SAFE_INTEGER;
    let maxProcessedSequence = 0;
    for (const object of keyPackages) {
      if (object.accountId !== runtime.state.accountId) throw new Error('Sync metadata belongs to another account.');
      const objectEpoch = object.keyEpoch || 1;
      if (objectEpoch > currentAccountEpoch) {
        emitSyncTelemetry('sync.key_package.future_epoch_deferred', {
          sequence: object.sequence,
          keyEpoch: objectEpoch,
          currentAccountEpoch,
        }, 'warn');
        continue;
      }
      if (runtime.secrets.accountRootKeys?.[objectEpoch]) {
        maxProcessedSequence = Math.max(maxProcessedSequence, object.sequence);
        continue;
      }

      let decoded;
      try {
        const bytes = await downloadVerifiedSyncObject(runtime.googleSession, object, this.download);
        decoded = decodeCompanionKeyPackage(bytes);
      } catch (error) {
        emitSyncTelemetry('sync.key_package.read_failed', {
          sequence: object.sequence,
          keyEpoch: object.keyEpoch || 1,
        }, 'warn');
        console.warn('Encrypted key package could not be read and will be retried later:', error);
        continue;
      }

      const packageEpoch = decoded.keyEpoch || objectEpoch;
      if (packageEpoch !== objectEpoch) {
        emitSyncTelemetry('sync.key_package.epoch_mismatch', {
          sequence: object.sequence,
          objectEpoch,
          packageEpoch,
        }, 'warn');
        console.warn('Encrypted key package epoch did not match control-plane metadata.');
        continue;
      }
      if (decoded.accountId !== runtime.state.accountId) {
        emitSyncTelemetry('sync.key_package.account_mismatch', {
          sequence: object.sequence,
          keyEpoch: packageEpoch,
        }, 'warn');
        console.warn('Encrypted key package belongs to another account.');
        continue;
      }
      maxProcessedSequence = Math.max(maxProcessedSequence, object.sequence);

      let unwrappedKeys: {
        keyEpoch: number;
        accountRootKey: Uint8Array;
        accountRootKeys: Record<number, Uint8Array>;
      };
      try {
        unwrappedKeys = await unwrapRootKeysForCompanion(
          decoded,
          runtime.state.devicePublicKey,
          runtime.secrets.devicePrivateKeyJwk,
        );
      } catch (error: any) {
        if (error instanceof CompanionKeyPackageError && error.code === 'TARGET_DEVICE_MISMATCH') continue;
        emitSyncTelemetry('sync.key_package.open_failed', {
          sequence: object.sequence,
          keyEpoch: packageEpoch,
          error: error?.message || 'Encrypted key package could not be opened.',
        }, 'warn');
        console.warn('Encrypted key package could not be opened and will be retried later:', error);
        continue;
      }

      const latestSecrets = (await this.dependencies.loadSecrets()) || runtime.secrets;
      const previousEpoch = runtime.state.keyEpoch || 1;
      const updatedSecrets = withAccountRootKeyForEpoch({
        ...latestSecrets,
        accountRootKeys: {
          ...(latestSecrets.accountRootKeys || {}),
          [previousEpoch]: latestSecrets.accountRootKey,
          ...unwrappedKeys.accountRootKeys,
        },
      }, packageEpoch, unwrappedKeys.accountRootKeys[packageEpoch] || unwrappedKeys.accountRootKey);
      await this.dependencies.saveSecrets(updatedSecrets);
      runtime.secrets = updatedSecrets;

      const currentState = (await this.repository.getLocalSyncAccountState()) || runtime.state;
      const updatedState = {
        ...currentState,
        keyEpoch: Math.max(currentState.keyEpoch || 1, packageEpoch),
      };
      await this.repository.saveLocalSyncAccountState(updatedState);
      runtime.state = updatedState;
      emitSyncTelemetry('sync.key_package.applied', {
        sequence: object.sequence,
        keyEpoch: packageEpoch,
      });
    }
    return maxProcessedSequence;
  }

  private async pullGlobalKeyPackagesForPartitionedRuntime(
    runtime: RemotePullRuntime,
    state: LocalSyncAccountState,
  ): Promise<void> {
    if (typeof runtime.controlPlane.listSyncObjectsAfter !== 'function') return;
    let scanAfterSequence = state.currentSyncSequence;
    let maxProcessedSequence = 0;
    while (true) {
      const objects = await runtime.controlPlane.listSyncObjectsAfter(state.deviceId, scanAfterSequence, 100);
      if (objects.length === 0) break;
      maxProcessedSequence = Math.max(maxProcessedSequence, await this.processKeyPackages(runtime, objects));
      scanAfterSequence = Math.max(scanAfterSequence, ...objects.map(object => object.sequence));
      if (objects.length < 100) break;
    }
    if (maxProcessedSequence > state.currentSyncSequence) {
      const currentState = (await this.repository.getLocalSyncAccountState()) || state;
      await this.repository.saveLocalSyncAccountState({
        ...currentState,
        currentSyncSequence: Math.max(currentState.currentSyncSequence, maxProcessedSequence),
      });
    }
  }
}
