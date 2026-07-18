import { emitSyncTelemetry } from '../../sync/syncTelemetry';

export const reportUnexpectedError = (source: string, _error: unknown): void => {
  emitSyncTelemetry('app.unexpected_error', { source, unexpected: true }, 'error');
};
