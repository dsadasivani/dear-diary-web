import { fullJitterDelay, type RetryPolicy } from '../../infrastructure/http/retryPolicy';
import { SyncError } from '../errors';
import type { SyncOutboxOperationV2, SyncOutboxStateV2 } from './SyncOutboxOperationV2';

const RETRY_POLICY: RetryPolicy = {
  maxAttempts: Number.MAX_SAFE_INTEGER,
  baseDelayMs: 2_000,
  maxDelayMs: 6 * 60 * 60 * 1_000,
  retryableStatuses: new Set(),
};

export const stateForSyncError = (error: SyncError): SyncOutboxStateV2 => {
  if (error.code === 'RECORD_VERSION_CONFLICT') return 'CONFLICT';
  if (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_INVALID') return 'BLOCKED_AUTH';
  if (error.code === 'DEVICE_REVOKED') return 'BLOCKED_DEVICE';
  if (error.code === 'PROTOCOL_INCOMPATIBLE' || error.code === 'SCHEMA_INCOMPATIBLE') return 'BLOCKED_UPGRADE';
  if (error.safetyRelevant) return 'SAFETY_STOP';
  return error.retryable ? 'RETRY_WAIT' : 'SAFETY_STOP';
};

export const scheduleOutboxFailure = (
  operation: SyncOutboxOperationV2,
  error: SyncError,
  now: number,
  random: () => number = Math.random,
): Partial<SyncOutboxOperationV2> & { state: SyncOutboxStateV2 } => {
  const state = stateForSyncError(error);
  const retryCount = operation.retryCount + 1;
  return {
    state,
    retryCount,
    nextAttemptAt: state === 'RETRY_WAIT'
      ? now + (error.retryAfterMs ?? fullJitterDelay(retryCount, RETRY_POLICY, random))
      : operation.nextAttemptAt,
    lastErrorCode: error.code,
    lastErrorAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  };
};

