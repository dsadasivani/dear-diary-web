import { mapHttpError, providerShapeOf } from './errorMapping';
import { SyncError } from './SyncError';

const CODE_MAP: Record<string, SyncError> = {
  RECORD_VERSION_CONFLICT: new SyncError({
    code: 'RECORD_VERSION_CONFLICT',
    userActionRequired: true,
  }),
  DEVICE_REVOKED: new SyncError({ code: 'DEVICE_REVOKED', userActionRequired: true }),
  SEQUENCE_CONFLICT: new SyncError({ code: 'SEQUENCE_CONFLICT', retryable: true }),
};

export const mapSupabaseError = (error: unknown): SyncError => {
  const code = String(providerShapeOf(error).code || '');
  const mapped = CODE_MAP[code];
  if (mapped)
    return new SyncError({
      code: mapped.code,
      retryable: mapped.retryable,
      userActionRequired: mapped.userActionRequired,
      safetyRelevant: mapped.safetyRelevant,
      cause: error,
    });
  return mapHttpError(error);
};
