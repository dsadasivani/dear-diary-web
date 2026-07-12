import { providerShapeOf } from './errorMapping';
import { SyncError } from './SyncError';

export const mapStorageError = (error: unknown): SyncError => {
  const { name, code } = providerShapeOf(error);
  if (name === 'QuotaExceededError' || code === 22 || code === 1014) {
    return new SyncError({ code: 'LOCAL_STORAGE_FULL', userActionRequired: true, cause: error });
  }
  return new SyncError({ code: 'LOCAL_DATABASE_FAILURE', safetyRelevant: true, cause: error });
};

