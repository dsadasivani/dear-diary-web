import { executeRequest } from '../../../infrastructure/http/executeRequest';
import { mapHttpError } from '../../errors/errorMapping';
import { SyncError } from '../../errors';
import type {
  InitiateSyncV2OperationRequest,
  InitiateSyncV2OperationResponse,
  InitiateSyncV2SnapshotRequest,
  InitiateSyncV2SnapshotResponse,
  PullSyncV2EventsResponse,
  SyncV2CommitResult,
  SyncV2OperationStatus,
  SyncV2Protocol,
  SyncV2Snapshot,
} from './SyncV2ApiTypes';

export type SyncV2AccessTokenProvider = () => Promise<string>;

export interface SyncV2ApiClientConfig {
  baseUrl: string;
  accessToken: SyncV2AccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ApiErrorBody {
  code?: string;
  retryable?: boolean;
  userActionRequired?: boolean;
}

const API_CODE_MAP: Record<string, ConstructorParameters<typeof SyncError>[0]['code']> = {
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  RECORD_VERSION_CONFLICT: 'RECORD_VERSION_CONFLICT',
  PROTOCOL_INCOMPATIBLE: 'PROTOCOL_INCOMPATIBLE',
  KEY_EPOCH_MISMATCH: 'KEY_EPOCH_UNAVAILABLE',
  OBJECT_MISSING: 'OBJECT_MISSING',
  HASH_MISMATCH: 'HASH_MISMATCH',
  SEQUENCE_GAP: 'SEQUENCE_GAP',
  CURSOR_AHEAD: 'SEQUENCE_REGRESSION',
  CURSOR_REGRESSION: 'SEQUENCE_REGRESSION',
  SNAPSHOT_NOT_FOUND: 'OBJECT_MISSING',
  SNAPSHOT_SEQUENCE_STALE: 'SEQUENCE_CONFLICT',
  SNAPSHOT_CREATION_DISABLED: 'SERVER_UNAVAILABLE',
  SNAPSHOT_PARTITION_UNSUPPORTED: 'PROTOCOL_INCOMPATIBLE',
  SNAPSHOT_DEVICE_MISMATCH: 'DEVICE_REVOKED',
};

export class SyncV2ApiClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: SyncV2ApiClientConfig) {
    this.fetcher = config.fetch || fetch;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  getProtocol(): Promise<SyncV2Protocol> {
    return this.json('/api/v2/sync/protocol', { method: 'GET' });
  }

  initiateOperation(request: InitiateSyncV2OperationRequest): Promise<InitiateSyncV2OperationResponse> {
    return this.json('/api/v2/sync/operations/initiate', { method: 'POST', body: JSON.stringify(request) });
  }

  commitOperation(operationId: string): Promise<SyncV2CommitResult> {
    return this.json(`/api/v2/sync/operations/${encodeURIComponent(operationId)}/commit`, { method: 'POST' });
  }

  getOperation(operationId: string): Promise<SyncV2OperationStatus> {
    return this.json(`/api/v2/sync/operations/${encodeURIComponent(operationId)}`, { method: 'GET' });
  }

  pullEvents(after: number, limit: number): Promise<PullSyncV2EventsResponse> {
    return this.json(`/api/v2/sync/events?after=${after}&limit=${limit}`, { method: 'GET' });
  }

  async acknowledgeCursor(deviceId: string, lastAppliedSequence: number): Promise<void> {
    await this.json(`/api/v2/sync/devices/${encodeURIComponent(deviceId)}/cursor`, {
      method: 'POST',
      body: JSON.stringify({ lastAppliedSequence }),
    });
  }

  initiateSnapshot(request: InitiateSyncV2SnapshotRequest): Promise<InitiateSyncV2SnapshotResponse> {
    return this.json('/api/v2/sync/snapshots/initiate', { method: 'POST', body: JSON.stringify(request) });
  }

  registerSnapshot(snapshotId: string, deviceId: string): Promise<SyncV2Snapshot> {
    return this.json(
      `/api/v2/sync/snapshots/${encodeURIComponent(snapshotId)}/register?deviceId=${encodeURIComponent(deviceId)}`,
      { method: 'POST' },
    );
  }

  getLatestSnapshot(snapshotSchemaVersion: number): Promise<SyncV2Snapshot> {
    return this.json(
      `/api/v2/sync/snapshots/latest?partitionKey=account&snapshotSchemaVersion=${snapshotSchemaVersion}`,
      { method: 'GET' },
    );
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    let apiError: SyncError | undefined;
    const response = await executeRequest({
      timeoutMs: this.config.timeoutMs,
      request: async ({ signal, correlationId }) => {
        apiError = undefined;
        const token = await this.config.accessToken();
        const candidate = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-correlation-id': correlationId,
            ...init.headers,
          },
        });
        if (!candidate.ok) apiError = await this.mapApiError(candidate.clone());
        return candidate;
      },
      mapError: error => apiError || mapHttpError(error),
      retryPolicy: { maxAttempts: init.method === 'GET' ? 3 : 1 },
    });
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }

  private async mapApiError(response: Response): Promise<SyncError> {
    let body: ApiErrorBody = {};
    try { body = await response.json() as ApiErrorBody; } catch { /* controlled fallback */ }
    const mappedCode = body.code ? API_CODE_MAP[body.code] : undefined;
    if (mappedCode) {
      return new SyncError({
        code: mappedCode,
        retryable: body.retryable,
        userActionRequired: body.userActionRequired,
        safetyRelevant: ['HASH_MISMATCH', 'SEQUENCE_GAP'].includes(mappedCode),
        cause: { status: response.status, code: body.code },
      });
    }
    return mapHttpError({ status: response.status });
  }
}
