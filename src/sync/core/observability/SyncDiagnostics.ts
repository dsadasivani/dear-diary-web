import type { SyncHealth } from '../../health/SyncHealth';
import type { SyncOperation } from '../../outbox';
import type { SyncFeatureFlags } from '../api/SyncApiTypes';

export interface SyncDiagnosticsInput {
  appVersion: string;
  platform: string;
  protocolVersion: number;
  databaseSchemaVersion: number;
  operations: SyncOperation[];
  health: SyncHealth;
  featureFlags: SyncFeatureFlags;
  performanceBuckets?: Record<string, number>;
}

export const exportSyncDiagnostics = (input: SyncDiagnosticsInput) => ({
  appVersion: input.appVersion,
  platform: input.platform,
  protocolVersion: input.protocolVersion,
  databaseSchemaVersion: input.databaseSchemaVersion,
  outboxCounts: Object.fromEntries(
    [...new Set(input.operations.map((operation) => operation.state))].map((state) => [
      state,
      input.operations.filter((operation) => operation.state === state).length,
    ]),
  ),
  syncHealth: {
    lastPushAttemptAt: input.health.lastPushAttemptAt,
    lastSuccessfulPushAt: input.health.lastSuccessfulPushAt,
    lastPullAttemptAt: input.health.lastPullAttemptAt,
    lastSuccessfulPullAt: input.health.lastSuccessfulPullAt,
    sequenceLag: input.health.sequenceLag,
    integrityState: input.health.integrityState,
  },
  errorCodeCounts: Object.fromEntries(
    [...new Set(input.operations.map((operation) => operation.lastErrorCode).filter(Boolean))].map(
      (code) => [
        code!,
        input.operations.filter((operation) => operation.lastErrorCode === code).length,
      ],
    ),
  ),
  featureFlags: input.featureFlags,
  performanceBuckets: input.performanceBuckets || {},
});
