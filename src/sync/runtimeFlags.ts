export interface SyncRuntimeFlags {
  syncV2Enabled: boolean;
  syncWritesEnabled: boolean;
  remotePullEnabled: boolean;
  realtimeEnabled: boolean;
  automaticGarbageCollectionEnabled: boolean;
  snapshotCreationEnabled: boolean;
  archiveHydrationEnabled: boolean;
  mediaUploadEnabled: boolean;
  keyRotationEnabled: boolean;
  deviceRevocationEnabled: boolean;
  primaryRecoveryEnabled: boolean;
}

export const SAFE_SYNC_RUNTIME_FLAGS: Readonly<SyncRuntimeFlags> = Object.freeze({
  syncV2Enabled: false,
  syncWritesEnabled: true,
  remotePullEnabled: true,
  realtimeEnabled: false,
  automaticGarbageCollectionEnabled: false,
  snapshotCreationEnabled: false,
  archiveHydrationEnabled: false,
  mediaUploadEnabled: true,
  keyRotationEnabled: false,
  deviceRevocationEnabled: false,
  primaryRecoveryEnabled: false,
});

let runtimeOverrides: Partial<SyncRuntimeFlags> = {};

export const getSyncRuntimeFlags = (): Readonly<SyncRuntimeFlags> => Object.freeze({
  ...SAFE_SYNC_RUNTIME_FLAGS,
  ...runtimeOverrides,
});

export const configureSyncRuntimeFlags = (overrides: Partial<SyncRuntimeFlags>): Readonly<SyncRuntimeFlags> => {
  runtimeOverrides = { ...runtimeOverrides, ...overrides };
  return getSyncRuntimeFlags();
};

export const resetSyncRuntimeFlags = (): void => {
  runtimeOverrides = {};
};

