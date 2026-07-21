import { SyncError } from './SyncError';
import type { SyncErrorCode } from './SyncErrorCode';

export interface ProviderErrorShape {
  status?: number;
  code?: string | number;
  name?: string;
}

const shapeOf = (error: unknown): ProviderErrorShape => {
  if (!error || typeof error !== 'object') return {};
  const value = error as Record<string, unknown>;
  return {
    status: typeof value.status === 'number' ? value.status : undefined,
    code: typeof value.code === 'string' || typeof value.code === 'number' ? value.code : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
  };
};

export const mapHttpError = (
  error: unknown,
  fallbackCode: SyncErrorCode = 'UNKNOWN',
): SyncError => {
  if (error instanceof SyncError) return error;
  const { status, name } = shapeOf(error);
  if (name === 'AbortError')
    return new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true, cause: error });
  if (status === 401)
    return new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true, cause: error });
  if (status === 403)
    return new SyncError({ code: 'AUTH_INVALID', userActionRequired: true, cause: error });
  if (status === 404)
    return new SyncError({ code: 'OBJECT_MISSING', safetyRelevant: true, cause: error });
  if (status === 408)
    return new SyncError({ code: 'REQUEST_TIMEOUT', retryable: true, cause: error });
  if (status === 409)
    return new SyncError({
      code: 'RECORD_VERSION_CONFLICT',
      userActionRequired: true,
      cause: error,
    });
  if (status === 429) return new SyncError({ code: 'RATE_LIMITED', retryable: true, cause: error });
  if (status !== undefined && status >= 500)
    return new SyncError({ code: 'SERVER_UNAVAILABLE', retryable: true, cause: error });
  return new SyncError({
    code: fallbackCode,
    safetyRelevant: fallbackCode === 'UNKNOWN',
    cause: error,
  });
};

export const providerShapeOf = shapeOf;
