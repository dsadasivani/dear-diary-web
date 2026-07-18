import { mapHttpError, providerShapeOf } from './errorMapping';
import { SyncError } from './SyncError';

export const mapDriveError = (
  error: unknown,
  operation: 'upload' | 'download' | 'delete' | 'list' = 'list',
): SyncError => {
  const { status, code } = providerShapeOf(error);
  if (status === 403 && (code === 'storageQuotaExceeded' || code === 'dailyLimitExceeded')) {
    return new SyncError({
      code: 'STORAGE_QUOTA_EXCEEDED',
      userActionRequired: true,
      cause: error,
    });
  }
  const fallback =
    operation === 'upload'
      ? 'OBJECT_UPLOAD_FAILED'
      : operation === 'download'
        ? 'OBJECT_DOWNLOAD_FAILED'
        : 'UNKNOWN';
  return mapHttpError(error, fallback);
};
