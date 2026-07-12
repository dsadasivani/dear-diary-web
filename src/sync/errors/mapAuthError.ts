import { mapHttpError, providerShapeOf } from './errorMapping';
import { SyncError } from './SyncError';

export const mapAuthError = (error: unknown): SyncError => {
  const { code } = providerShapeOf(error);
  if (code === 'refresh_token_not_found' || code === 'refresh_token_already_used') {
    return new SyncError({ code: 'AUTH_EXPIRED', userActionRequired: true, cause: error });
  }
  return mapHttpError(error, 'AUTH_INVALID');
};

