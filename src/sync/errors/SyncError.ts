import type { SyncErrorCode } from './SyncErrorCode';

export interface SyncErrorOptions {
  code: SyncErrorCode;
  retryable?: boolean;
  userActionRequired?: boolean;
  safetyRelevant?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

const SAFE_MESSAGES: Record<SyncErrorCode, string> = {
  OFFLINE: 'Synchronization is waiting for an internet connection.',
  REQUEST_TIMEOUT: 'The synchronization request timed out.',
  AUTH_EXPIRED: 'Sign in again to resume synchronization.',
  AUTH_INVALID: 'Synchronization authorization is invalid.',
  DEVICE_REVOKED: 'This device is no longer authorized to synchronize.',
  RATE_LIMITED: 'Synchronization is temporarily rate limited.',
  STORAGE_QUOTA_EXCEEDED: 'Cloud storage is full.',
  OBJECT_UPLOAD_FAILED: 'An encrypted object could not be uploaded.',
  OBJECT_DOWNLOAD_FAILED: 'An encrypted object could not be downloaded.',
  OBJECT_MISSING: 'A required encrypted object is missing.',
  OBJECT_SIZE_MISMATCH: 'An encrypted object failed its size check.',
  HASH_MISMATCH: 'An encrypted object failed its integrity check.',
  DECRYPTION_FAILED: 'An encrypted object could not be opened safely.',
  SEQUENCE_CONFLICT: 'The remote sequence changed unexpectedly.',
  SEQUENCE_GAP: 'A gap was found in the remote event sequence.',
  SEQUENCE_REGRESSION: 'The remote event sequence moved backwards.',
  RECORD_VERSION_CONFLICT: 'A newer version exists on another device.',
  PROTOCOL_INCOMPATIBLE: 'This app version cannot use the current synchronization protocol.',
  SCHEMA_INCOMPATIBLE: 'This app cannot safely read the synchronized data schema.',
  KEY_EPOCH_UNAVAILABLE: 'A required encryption key is not available on this device.',
  LOCAL_DATABASE_FAILURE: 'The local database could not complete the operation.',
  LOCAL_STORAGE_FULL: 'This device does not have enough storage.',
  SERVER_UNAVAILABLE: 'Synchronization is temporarily unavailable.',
  DEPENDENCY_BLOCKED: 'Synchronization is waiting for an earlier operation.',
  INVARIANT_VIOLATION: 'Synchronization paused to protect local data.',
  UNKNOWN: 'An unexpected synchronization failure occurred.',
};

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly retryable: boolean;
  readonly userActionRequired: boolean;
  readonly safetyRelevant: boolean;
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(options: SyncErrorOptions) {
    super(SAFE_MESSAGES[options.code], { cause: options.cause });
    this.name = 'SyncError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.userActionRequired = options.userActionRequired ?? false;
    this.safetyRelevant = options.safetyRelevant ?? options.code === 'UNKNOWN';
    this.retryAfterMs = options.retryAfterMs;
    this.cause = options.cause;
  }
}

export const isSyncError = (value: unknown): value is SyncError => value instanceof SyncError;
