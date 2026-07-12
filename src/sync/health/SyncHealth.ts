import type { SyncErrorCode } from '../errors';

export interface SyncHealth {
  accountId?: string;
  lastLocalWriteAt?: number;
  lastPushAttemptAt?: number;
  lastSuccessfulPushAt?: number;
  lastPullAttemptAt?: number;
  lastSuccessfulPullAt?: number;
  lastRealtimeSignalAt?: number;
  pendingOperationCount: number;
  processingOperationCount: number;
  retryingOperationCount: number;
  blockedOperationCount: number;
  conflictOperationCount: number;
  failedOperationCount: number;
  oldestPendingOperationAt?: number;
  localSequence: number;
  remoteSequence?: number;
  sequenceLag?: number;
  authState: 'UNKNOWN' | 'VALID' | 'REFRESHING' | 'EXPIRED' | 'MISSING';
  connectivityState: 'ONLINE' | 'OFFLINE' | 'DEGRADED';
  realtimeState: 'DISABLED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';
  integrityState: 'HEALTHY' | 'WARNING' | 'SAFETY_STOP';
  lastErrorCode?: SyncErrorCode;
  lastErrorAt?: number;
  updatedAt: number;
}

export const createDefaultSyncHealth = (now = Date.now()): SyncHealth => ({
  pendingOperationCount: 0,
  processingOperationCount: 0,
  retryingOperationCount: 0,
  blockedOperationCount: 0,
  conflictOperationCount: 0,
  failedOperationCount: 0,
  localSequence: 0,
  authState: 'UNKNOWN',
  connectivityState: typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'ONLINE',
  realtimeState: 'DISABLED',
  integrityState: 'HEALTHY',
  updatedAt: now,
});

export type SyncHealthPatch = Partial<Omit<SyncHealth, 'updatedAt'>>;

export const exportPrivacySafeSyncDiagnostics = (
  health: SyncHealth,
  applicationVersion: string,
  protocolVersion = 1,
) => {
  const { accountId: _accountId, ...safeHealth } = health;
  return { protocolVersion, applicationVersion, health: safeHealth };
};
