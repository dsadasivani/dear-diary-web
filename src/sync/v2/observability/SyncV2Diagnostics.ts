import type { SyncHealth } from '../../health/SyncHealth';
import type { SyncOutboxOperationV2 } from '../../outbox';
import type { SyncV2FeatureFlags } from '../api/SyncV2ApiTypes';

export interface SyncV2DiagnosticsInput {
  appVersion: string;
  platform: string;
  protocolVersion: number;
  databaseSchemaVersion: number;
  operations: SyncOutboxOperationV2[];
  health: SyncHealth;
  featureFlags: SyncV2FeatureFlags;
  performanceBuckets?: Record<string, number>;
}

export const exportSyncV2Diagnostics = (input: SyncV2DiagnosticsInput) => ({
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
