import type { LocalDataStore } from '../../../platform/storage';
import type { SyncV2FeatureFlags, SyncV2Protocol } from '../api/SyncV2ApiTypes';

const STORAGE_KEY = 'deardiary_sync_v2_runtime_controls';

export interface CachedRuntimeControls {
  featureFlags: SyncV2FeatureFlags;
  minimumSupportedAppVersion: string;
  minimumReadProtocolVersion: number;
  minimumWriteProtocolVersion: number;
  currentProtocolVersion: number;
  eventSchemaVersion: number;
  snapshotSchemaVersion: number;
  maximumEventBytes: number;
  maximumMediaBytes: number;
  syncV2RolloutPercentage: number;
  rolloutSaltVersion: number;
  emergencyMode: boolean;
  fetchedAt: number;
}

const destructiveOff = (partial: Partial<SyncV2FeatureFlags> = {}): SyncV2FeatureFlags => ({
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
  featureFlags: destructiveOff(), minimumSupportedAppVersion: '0.0.0',
  minimumReadProtocolVersion: Number.MAX_SAFE_INTEGER, minimumWriteProtocolVersion: Number.MAX_SAFE_INTEGER,
  currentProtocolVersion: 1, eventSchemaVersion: 1, snapshotSchemaVersion: 1,
  maximumEventBytes: 0, maximumMediaBytes: 0,
  syncV2RolloutPercentage: 0, rolloutSaltVersion: 1, emergencyMode: true, fetchedAt: 0,
};

export class RuntimeControlStore {
  constructor(private readonly store: LocalDataStore, private readonly now: () => number = Date.now) {}
  async save(protocol: SyncV2Protocol): Promise<CachedRuntimeControls> {
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
      syncV2RolloutPercentage: protocol.syncV2RolloutPercentage,
      rolloutSaltVersion: protocol.rolloutSaltVersion,
      emergencyMode: protocol.emergencyMode,
      fetchedAt: this.now(),
    };
    await this.store.setItem(STORAGE_KEY, JSON.stringify(controls));
    return controls;
  }
  async loadSafeFallback(): Promise<CachedRuntimeControls> {
    const raw = await this.store.getItem(STORAGE_KEY);
    if (!raw) return EMERGENCY_RUNTIME_CONTROLS;
    const cached = JSON.parse(raw) as CachedRuntimeControls;
    return { ...cached, featureFlags: destructiveOff({ remotePullEnabled: cached.featureFlags.remotePullEnabled }), emergencyMode: true };
  }

  asProtocol(controls: CachedRuntimeControls): SyncV2Protocol {
    return {
      minimumReadProtocolVersion: controls.minimumReadProtocolVersion,
      minimumWriteProtocolVersion: controls.minimumWriteProtocolVersion,
      currentProtocolVersion: controls.currentProtocolVersion,
      eventSchemaVersion: controls.eventSchemaVersion,
      snapshotSchemaVersion: controls.snapshotSchemaVersion,
      maximumEventBytes: controls.maximumEventBytes,
      maximumMediaBytes: controls.maximumMediaBytes,
      minimumSupportedAppVersion: controls.minimumSupportedAppVersion,
      syncV2RolloutPercentage: controls.syncV2RolloutPercentage,
      rolloutSaltVersion: controls.rolloutSaltVersion,
      emergencyMode: controls.emergencyMode,
      featureFlags: controls.featureFlags,
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

export const isCanaryEnabled = async (pseudonym: string, percentage: number, saltVersion: number): Promise<boolean> => {
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${saltVersion}:${pseudonym}`)));
  return (((bytes[0] << 8) | bytes[1]) % 100) < percentage;
};
