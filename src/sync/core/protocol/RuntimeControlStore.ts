import type { LocalDataStore } from '../../../platform/storage';
import type { SyncFeatureFlags, SyncProtocol } from '../api/SyncApiTypes';

const STORAGE_KEY = 'deardiary_sync_runtime_controls';

export interface CachedRuntimeControls {
  featureFlags: SyncFeatureFlags;
  minimumSupportedAppVersion: string;
  minimumReadProtocolVersion: number;
  minimumWriteProtocolVersion: number;
  currentProtocolVersion: number;
  eventSchemaVersion: number;
  snapshotSchemaVersion: number;
  maximumEventBytes: number;
  maximumMediaBytes: number;
  maximumSnapshotBytes: number;
  emergencyMode: boolean;
  bootstrapControls?: SyncProtocol['bootstrapControls'];
  fetchedAt: number;
}

const destructiveOff = (partial: Partial<SyncFeatureFlags> = {}): SyncFeatureFlags => ({
  syncWritesEnabled: false,
  remotePullEnabled: partial.remotePullEnabled ?? false,
  realtimeEnabled: false,
  snapshotCreationEnabled: false,
  garbageCollectionEnabled: false,
  mediaUploadEnabled: false,
  archiveHydrationEnabled: false,
  keyRotationEnabled: false,
  deviceRevocationEnabled: false,
  primaryRecoveryEnabled: false,
  companionPairingEnabled: false,
});

export const EMERGENCY_RUNTIME_CONTROLS: CachedRuntimeControls = {
  featureFlags: destructiveOff(),
  minimumSupportedAppVersion: '0.0.0',
  minimumReadProtocolVersion: Number.MAX_SAFE_INTEGER,
  minimumWriteProtocolVersion: Number.MAX_SAFE_INTEGER,
  currentProtocolVersion: 1,
  eventSchemaVersion: 1,
  snapshotSchemaVersion: 1,
  maximumEventBytes: 0,
  maximumMediaBytes: 0,
  maximumSnapshotBytes: 0,
  emergencyMode: true,
  bootstrapControls: {
    rollingSnapshotsEnabled: false,
    bootstrapManifestEnabled: false,
    retentionDeletionEnabled: false,
    softTailEvents: 100,
    hardTailEvents: 500,
    maximumSnapshotAgeDays: 7,
    replayBatchSize: 25,
    bootstrapExpiryMinutes: 60,
  },
  fetchedAt: 0,
};

export class RuntimeControlStore {
  constructor(
    private readonly store: LocalDataStore,
    private readonly now: () => number = Date.now,
  ) {}
  async save(protocol: SyncProtocol): Promise<CachedRuntimeControls> {
    const controls: CachedRuntimeControls = {
      featureFlags: protocol.emergencyMode
        ? destructiveOff({ remotePullEnabled: protocol.featureFlags.remotePullEnabled })
        : protocol.featureFlags,
      minimumSupportedAppVersion: protocol.minimumSupportedAppVersion,
      minimumReadProtocolVersion: protocol.minimumReadProtocolVersion,
      minimumWriteProtocolVersion: protocol.minimumWriteProtocolVersion,
      currentProtocolVersion: protocol.currentProtocolVersion,
      eventSchemaVersion: protocol.eventSchemaVersion,
      snapshotSchemaVersion: protocol.snapshotSchemaVersion,
      maximumEventBytes: protocol.maximumEventBytes,
      maximumMediaBytes: protocol.maximumMediaBytes,
      maximumSnapshotBytes: protocol.maximumSnapshotBytes,
      emergencyMode: protocol.emergencyMode,
      bootstrapControls: protocol.bootstrapControls,
      fetchedAt: this.now(),
    };
    await this.store.setItem(STORAGE_KEY, JSON.stringify(controls));
    return controls;
  }
  async loadSafeFallback(): Promise<CachedRuntimeControls> {
    const raw = await this.store.getItem(STORAGE_KEY);
    if (!raw) return EMERGENCY_RUNTIME_CONTROLS;
    const cached = JSON.parse(raw) as CachedRuntimeControls;
    return {
      ...cached,
      maximumSnapshotBytes: cached.maximumSnapshotBytes || 0,
      featureFlags: destructiveOff({ remotePullEnabled: cached.featureFlags.remotePullEnabled }),
      emergencyMode: true,
    };
  }

  asProtocol(controls: CachedRuntimeControls): SyncProtocol {
    return {
      minimumReadProtocolVersion: controls.minimumReadProtocolVersion,
      minimumWriteProtocolVersion: controls.minimumWriteProtocolVersion,
      currentProtocolVersion: controls.currentProtocolVersion,
      eventSchemaVersion: controls.eventSchemaVersion,
      snapshotSchemaVersion: controls.snapshotSchemaVersion,
      maximumEventBytes: controls.maximumEventBytes,
      maximumMediaBytes: controls.maximumMediaBytes,
      maximumSnapshotBytes: controls.maximumSnapshotBytes,
      minimumSupportedAppVersion: controls.minimumSupportedAppVersion,
      emergencyMode: controls.emergencyMode,
      featureFlags: controls.featureFlags,
      bootstrapControls: controls.bootstrapControls,
    };
  }
}

export const isVersionAtLeast = (current: string, minimum: string): boolean => {
  const left = current.split('.').map(Number);
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return true;
};
