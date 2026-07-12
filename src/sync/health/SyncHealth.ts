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
  connectivityState: typeof window !== 'undefined' && typeof navigator !== 'undefined' && !navigator.onLine
    ? 'OFFLINE'
    : 'ONLINE',
  realtimeState: 'DISABLED',
  integrityState: 'HEALTHY',
  updatedAt: now,
});

export type SyncHealthPatch = Partial<Omit<SyncHealth, 'updatedAt'>>;

export type SyncHealthStatusMessage =
  | 'All changes saved locally and synchronized'
  | 'Changes saved locally; waiting for internet'
  | 'Changes saved locally; sign-in required to synchronize'
  | 'Synchronization delayed; automatic retry scheduled'
  | 'Conflict requires review'
  | 'Synchronization paused for data safety';

export const getSyncHealthStatusMessage = (health: SyncHealth): SyncHealthStatusMessage => {
  if (health.integrityState === 'SAFETY_STOP') return 'Synchronization paused for data safety';
  if (health.conflictOperationCount > 0) return 'Conflict requires review';
  if (health.authState === 'EXPIRED' || health.authState === 'MISSING') {
    return 'Changes saved locally; sign-in required to synchronize';
  }
  if (health.connectivityState === 'OFFLINE') return 'Changes saved locally; waiting for internet';
  if (
    health.pendingOperationCount > 0 ||
    health.processingOperationCount > 0 ||
    health.retryingOperationCount > 0 ||
    health.blockedOperationCount > 0 ||
    health.failedOperationCount > 0
  ) {
    return 'Synchronization delayed; automatic retry scheduled';
  }
  return 'All changes saved locally and synchronized';
};

export const formatSyncHealthAge = (timestamp: number | undefined, now = Date.now()): string => {
  if (timestamp === undefined) return 'None';
  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return 'Less than a minute';
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} ${elapsedHours === 1 ? 'hr' : 'hrs'}`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} ${elapsedDays === 1 ? 'day' : 'days'}`;
};

export const exportPrivacySafeSyncDiagnostics = (
  health: SyncHealth,
  applicationVersion: string,
  protocolVersion = 1,
) => {
  const safeHealth: Omit<SyncHealth, 'accountId'> = {
    lastLocalWriteAt: health.lastLocalWriteAt,
    lastPushAttemptAt: health.lastPushAttemptAt,
    lastSuccessfulPushAt: health.lastSuccessfulPushAt,
    lastPullAttemptAt: health.lastPullAttemptAt,
    lastSuccessfulPullAt: health.lastSuccessfulPullAt,
    lastRealtimeSignalAt: health.lastRealtimeSignalAt,
    pendingOperationCount: health.pendingOperationCount,
    processingOperationCount: health.processingOperationCount,
    retryingOperationCount: health.retryingOperationCount,
    blockedOperationCount: health.blockedOperationCount,
    conflictOperationCount: health.conflictOperationCount,
    failedOperationCount: health.failedOperationCount,
    oldestPendingOperationAt: health.oldestPendingOperationAt,
    localSequence: health.localSequence,
    remoteSequence: health.remoteSequence,
    sequenceLag: health.sequenceLag,
    authState: health.authState,
    connectivityState: health.connectivityState,
    realtimeState: health.realtimeState,
    integrityState: health.integrityState,
    lastErrorCode: health.lastErrorCode,
    lastErrorAt: health.lastErrorAt,
    updatedAt: health.updatedAt,
  };
  return { protocolVersion, applicationVersion, health: safeHealth };
};
