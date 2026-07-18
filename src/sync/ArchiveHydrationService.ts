import type { DiaryRepository } from '../repositories/DiaryRepository';
import type { GoogleAccountSession, LocalSyncAccountState } from '../types';
import type { SyncSecrets } from './syncSecrets';
import type { SyncObjectDownloader } from './eventReplay';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import {
  hydrateArchivePartition as hydrateArchivePartitionFromCloud,
  type PartitionedRestoreInput,
  type PartitionedRestoreResult,
} from './partitionedRestore';
import {
  shouldBackgroundHydrateArchive,
  type ArchiveHydrationDecision,
  type ArchiveHydrationPolicyInput,
} from './partitionHydrationPolicy';
import { emitSyncTelemetry } from './syncTelemetry';

export interface BackgroundArchiveHydrationResult {
  decision: ArchiveHydrationDecision;
  hydratedPartitionKeys: string[];
}

export interface ArchiveHydrationRuntime {
  state: LocalSyncAccountState;
  secrets: SyncSecrets;
  googleSession: GoogleAccountSession;
  controlPlane: SupabaseControlPlaneClient;
}

export interface ArchiveHydrationRuntimeProvider {
  requireOnline: () => void;
  openRuntime: () => Promise<ArchiveHydrationRuntime>;
  assertActiveDevice: (controlPlane: SupabaseControlPlaneClient, deviceId: string) => Promise<void>;
}

type ArchivePartitionHydrator = (
  input: PartitionedRestoreInput & { partitionKey: string },
) => Promise<PartitionedRestoreResult>;

export interface ArchiveHydrationServiceDependencies {
  download?: SyncObjectDownloader;
  now?: () => number;
  getArchiveHydrationPolicyInput: () =>
    ArchiveHydrationPolicyInput | Promise<ArchiveHydrationPolicyInput>;
  backgroundArchiveBatchSize?: number;
  hydrateArchivePartition?: ArchivePartitionHydrator;
}

export const defaultArchiveHydrationPolicyInput = async (
  isOnline: () => boolean,
): Promise<ArchiveHydrationPolicyInput> => {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as any);
  const connection = nav?.connection || nav?.mozConnection || nav?.webkitConnection;
  const connectionType = String(connection?.type || '').toLowerCase();
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  const isCellular =
    connectionType === 'cellular' || ['slow-2g', '2g', '3g'].includes(effectiveType);
  let isCharging = true;
  let batteryLevel = 1;
  try {
    if (typeof nav?.getBattery === 'function') {
      const battery = await nav.getBattery();
      isCharging = Boolean(battery?.charging);
      batteryLevel = typeof battery?.level === 'number' ? battery.level : 1;
    }
  } catch {
    isCharging = true;
    batteryLevel = 1;
  }
  return {
    isOnline: isOnline(),
    isWifi: !isCellular,
    isCharging,
    batteryLevel,
    userAllowedMobileData: false,
    storagePressure: 'normal',
  };
};

export class ArchiveHydrationService {
  private readonly download?: SyncObjectDownloader;
  private readonly now: () => number;
  private readonly getArchiveHydrationPolicyInput: () =>
    ArchiveHydrationPolicyInput | Promise<ArchiveHydrationPolicyInput>;
  private readonly backgroundArchiveBatchSize: number;
  private readonly hydrateArchivePartitionFromCloud: ArchivePartitionHydrator;

  constructor(
    private readonly repository: DiaryRepository,
    dependencies: ArchiveHydrationServiceDependencies,
  ) {
    this.download = dependencies.download;
    this.now = dependencies.now || Date.now;
    this.getArchiveHydrationPolicyInput = dependencies.getArchiveHydrationPolicyInput;
    this.backgroundArchiveBatchSize = Math.max(1, dependencies.backgroundArchiveBatchSize || 1);
    this.hydrateArchivePartitionFromCloud =
      dependencies.hydrateArchivePartition || hydrateArchivePartitionFromCloud;
  }

  async hydratePartition(runtime: ArchiveHydrationRuntime, partitionKey: string): Promise<void> {
    const startedAt = this.now();
    emitSyncTelemetry('sync.archive.partition.start', { partitionKey });
    await this.repository.markPartitionHydrating(partitionKey);
    try {
      const result = await this.hydrateArchivePartitionFromCloud({
        repository: this.repository,
        controlPlane: runtime.controlPlane,
        localState: runtime.state,
        accountRootKey: runtime.secrets.accountRootKey,
        accountRootKeys: runtime.secrets.accountRootKeys,
        googleSession: runtime.googleSession,
        partitionKey,
        download: this.download,
        now: new Date(this.now()),
      });
      if (!result.hydratedPartitionKeys.includes(partitionKey)) {
        throw new Error('Archive partition is not available in the latest manifest.');
      }
      const hydrationState = await this.repository.getPartitionHydrationState(partitionKey);
      await runtime.controlPlane.updatePartitionCursor({
        deviceId: runtime.state.deviceId,
        partitionKey,
        lastAppliedSequence: hydrationState.lastAppliedSequence,
        hydratedAt: new Date(this.now()).toISOString(),
      });
      const currentState = await this.repository.getLocalSyncAccountState();
      if (currentState) {
        await runtime.controlPlane.updateDeviceCursor({
          deviceId: currentState.deviceId,
          lastAppliedSequence: Math.max(
            currentState.currentSyncSequence,
            result.currentSyncSequence,
          ),
        });
      }
      emitSyncTelemetry('sync.archive.partition.complete', {
        partitionKey,
        durationMs: this.now() - startedAt,
        currentSyncSequence: result.currentSyncSequence,
      });
    } catch (error: any) {
      await this.repository.markPartitionHydrationFailed(
        partitionKey,
        error?.message || 'Archive hydration failed.',
      );
      const failedState = await this.repository.getPartitionHydrationState(partitionKey);
      emitSyncTelemetry(
        'sync.archive.partition.failed',
        {
          partitionKey,
          durationMs: this.now() - startedAt,
          error: error?.message || 'Archive hydration failed.',
          failureCount: failedState.failureCount || 1,
          nextRetryAt: failedState.nextRetryAt,
        },
        'warn',
      );
      throw error;
    }
  }

  async hydrateBackgroundArchiveOnce(
    runtimeProvider: ArchiveHydrationRuntimeProvider,
  ): Promise<BackgroundArchiveHydrationResult> {
    const policyInput = await this.getArchiveHydrationPolicyInput();
    const decision = shouldBackgroundHydrateArchive(policyInput);
    emitSyncTelemetry('sync.archive.background.policy', {
      allowed: decision.allowed,
      reason: decision.reason,
      isWifi: policyInput.isWifi,
      isCharging: policyInput.isCharging,
      storagePressure: policyInput.storagePressure || 'normal',
    });
    if (!decision.allowed) return { decision, hydratedPartitionKeys: [] };
    runtimeProvider.requireOnline();

    const state = await this.repository.getLocalSyncAccountState();
    if (!state?.partitionedSyncEnabled) {
      emitSyncTelemetry('sync.archive.background.skipped', { reason: 'partitioned_sync_disabled' });
      return { decision, hydratedPartitionKeys: [] };
    }

    const now = this.now();
    const candidates = (await this.repository.listAvailableArchiveMonths())
      .filter(
        (partition) =>
          partition.status === 'available' ||
          (partition.status === 'failed' && (partition.nextRetryAt || 0) <= now),
      )
      .slice(0, this.backgroundArchiveBatchSize);
    if (candidates.length === 0) {
      emitSyncTelemetry('sync.archive.background.skipped', { reason: 'no_retryable_partitions' });
      return { decision, hydratedPartitionKeys: [] };
    }

    const runtime = await runtimeProvider.openRuntime();
    await runtimeProvider.assertActiveDevice(runtime.controlPlane, runtime.state.deviceId);

    const hydratedPartitionKeys: string[] = [];
    for (const candidate of candidates) {
      try {
        await this.hydratePartition(runtime, candidate.partitionKey);
        hydratedPartitionKeys.push(candidate.partitionKey);
      } catch (error: any) {
        emitSyncTelemetry(
          'sync.archive.background.stopped_after_failure',
          {
            partitionKey: candidate.partitionKey,
            error: error?.message || 'Archive hydration failed.',
          },
          'warn',
        );
        break;
      }
    }
    emitSyncTelemetry('sync.archive.background.complete', {
      attemptedCount: candidates.length,
      hydratedCount: hydratedPartitionKeys.length,
      hydratedPartitionKeys,
    });
    return { decision, hydratedPartitionKeys };
  }
}
