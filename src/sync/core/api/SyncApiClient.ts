import { executeRequest } from '../../../infrastructure/http/executeRequest';
import { mapHttpError } from '../../errors/errorMapping';
import { SyncError } from '../../errors';
import type {
  InitiateSyncOperationRequest,
  InitiateSyncOperationResponse,
  InitiateSyncSnapshotRequest,
  InitiateSyncSnapshotResponse,
  PullSyncEventsResponse,
  SyncCommitResult,
  SyncOperationStatus,
  SyncProtocol,
  SyncSnapshot,
  SyncKeyPackage,
  SyncPairing,
  SyncRecovery,
  SyncRotation,
  SyncDeviceRegistration,
  SyncDevice,
  SyncMediaDownload,
  SyncQuota,
  SyncBootstrapReadiness,
  SyncBootstrapManifest,
} from './SyncApiTypes';

export type SyncAccessTokenProvider = () => Promise<string>;

export interface SyncApiClientConfig {
  baseUrl: string;
  accessToken: SyncAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ApiErrorBody {
  code?: string;
  retryable?: boolean;
  userActionRequired?: boolean;
}

const API_CODE_MAP: Record<string, ConstructorParameters<typeof SyncError>[0]['code']> = {
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  COMPANION_LIMIT_EXCEEDED: 'COMPANION_LIMIT_EXCEEDED',
  ENTRY_MEDIA_LIMIT_EXCEEDED: 'ENTRY_MEDIA_LIMIT_EXCEEDED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  RECORD_VERSION_CONFLICT: 'RECORD_VERSION_CONFLICT',
  PROTOCOL_INCOMPATIBLE: 'PROTOCOL_INCOMPATIBLE',
  KEY_EPOCH_MISMATCH: 'KEY_EPOCH_UNAVAILABLE',
  OBJECT_MISSING: 'OBJECT_MISSING',
  PAIRING_NOT_FOUND: 'PAIRING_NOT_FOUND',
  HASH_MISMATCH: 'HASH_MISMATCH',
  SEQUENCE_GAP: 'SEQUENCE_GAP',
  SNAPSHOT_REQUIRED: 'SNAPSHOT_REQUIRED',
  REBOOTSTRAP_REQUIRED: 'SNAPSHOT_REQUIRED',
  CURSOR_AHEAD: 'SEQUENCE_REGRESSION',
  CURSOR_REGRESSION: 'SEQUENCE_REGRESSION',
  RECOVERY_ALREADY_ACTIVE: 'RECOVERY_CONFLICT',
  INVALID_RECOVERY_TRANSITION: 'RECOVERY_CONFLICT',
  RECOVERY_NOT_FOUND: 'RECOVERY_CONFLICT',
  RECOVERY_CURSOR_STALE: 'SEQUENCE_CONFLICT',
  SNAPSHOT_NOT_FOUND: 'OBJECT_MISSING',
  SNAPSHOT_SEQUENCE_STALE: 'SEQUENCE_CONFLICT',
  SNAPSHOT_CREATION_DISABLED: 'SERVER_UNAVAILABLE',
  MEDIA_UPLOAD_DISABLED: 'SERVER_UNAVAILABLE',
  INVALID_MEDIA_REFERENCE: 'OBJECT_MISSING',
  SNAPSHOT_PARTITION_UNSUPPORTED: 'PROTOCOL_INCOMPATIBLE',
  SNAPSHOT_DEVICE_MISMATCH: 'DEVICE_REVOKED',
};

export class SyncApiClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: SyncApiClientConfig) {
    const configuredFetcher = config.fetch;
    this.fetcher = configuredFetcher
      ? (input, init) => configuredFetcher(input, init)
      : (input, init) => globalThis.fetch(input, init);
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  getProtocol(): Promise<SyncProtocol> {
    return this.json('/api/sync/protocol', { method: 'GET' });
  }

  getQuota(): Promise<SyncQuota> {
    return this.json('/api/sync/quota', { method: 'GET' });
  }

  registerDevice(request: {
    deviceId: string;
    devicePublicKey: string;
    deviceRole: 'PRIMARY' | 'COMPANION';
    protocolVersion: number;
    appVersion: string;
    initialKeyEpoch: number;
  }): Promise<SyncDeviceRegistration> {
    return this.json('/api/sync/devices', { method: 'POST', body: JSON.stringify(request) });
  }

  listDevices(requestingDeviceId: string): Promise<SyncDevice[]> {
    return this.json(
      `/api/sync/devices?requestingDeviceId=${encodeURIComponent(requestingDeviceId)}`,
      { method: 'GET' },
    );
  }

  revokeSelf(
    deviceId: string,
    possessionSignature: string,
  ): Promise<{ deviceId: string; deviceStatus: 'REVOKED' }> {
    return this.json(`/api/sync/devices/${encodeURIComponent(deviceId)}/revoke-self`, {
      method: 'POST',
      body: JSON.stringify({ possessionSignature }),
    });
  }

  initiateOperation(
    request: InitiateSyncOperationRequest,
  ): Promise<InitiateSyncOperationResponse> {
    return this.json('/api/sync/operations/initiate', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  commitOperation(operationId: string): Promise<SyncCommitResult> {
    return this.json(`/api/sync/operations/${encodeURIComponent(operationId)}/commit`, {
      method: 'POST',
    });
  }

  getOperation(operationId: string): Promise<SyncOperationStatus> {
    return this.json(`/api/sync/operations/${encodeURIComponent(operationId)}`, {
      method: 'GET',
    });
  }

  pullEvents(after: number, limit: number, through?: number): Promise<PullSyncEventsResponse> {
    const fixedWatermark = through === undefined ? '' : `&through=${through}`;
    return this.json(`/api/sync/events?after=${after}&limit=${limit}${fixedWatermark}`, {
      method: 'GET',
    });
  }

  getBootstrapReadiness(deviceId: string): Promise<SyncBootstrapReadiness> {
    return this.json(`/api/sync/bootstrap-readiness?deviceId=${encodeURIComponent(deviceId)}`, {
      method: 'GET',
    });
  }

  createBootstrap(request: {
    bootstrapId: string;
    deviceId: string;
    pairingId?: string;
  }): Promise<SyncBootstrapManifest> {
    return this.json('/api/sync/bootstraps', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  getBootstrap(bootstrapId: string): Promise<SyncBootstrapManifest> {
    return this.json(`/api/sync/bootstraps/${encodeURIComponent(bootstrapId)}`, {
      method: 'GET',
    });
  }

  completeBootstrap(
    bootstrapId: string,
    request: { deviceId: string; appliedThroughSequence: number; possessionSignature: string },
  ): Promise<SyncBootstrapManifest> {
    return this.json(`/api/sync/bootstraps/${encodeURIComponent(bootstrapId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  getMediaDownload(objectId: string): Promise<SyncMediaDownload> {
    return this.json(`/api/sync/media/${encodeURIComponent(objectId)}`, { method: 'GET' });
  }

  async acknowledgeCursor(deviceId: string, appliedSequence: number): Promise<void> {
    await this.json(`/api/sync/devices/${encodeURIComponent(deviceId)}/cursor`, {
      method: 'POST',
      body: JSON.stringify({ lastAppliedSequence: appliedSequence }),
    });
  }

  initiateSnapshot(
    request: InitiateSyncSnapshotRequest,
  ): Promise<InitiateSyncSnapshotResponse> {
    return this.json('/api/sync/snapshots/initiate', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  registerSnapshot(snapshotId: string, deviceId: string): Promise<SyncSnapshot> {
    return this.json(
      `/api/sync/snapshots/${encodeURIComponent(snapshotId)}/register?deviceId=${encodeURIComponent(deviceId)}`,
      { method: 'POST' },
    );
  }

  getLatestSnapshot(snapshotSchemaVersion: number): Promise<SyncSnapshot> {
    return this.json(
      `/api/sync/snapshots/latest?partitionKey=account&snapshotSchemaVersion=${snapshotSchemaVersion}`,
      { method: 'GET' },
    );
  }

  createPairing(request: Record<string, unknown>): Promise<SyncPairing> {
    return this.json('/api/sync/pairings', { method: 'POST', body: JSON.stringify(request) });
  }

  listPendingPairings(approverDeviceId: string): Promise<SyncPairing[]> {
    return this.json(
      `/api/sync/pairings/pending?approverDeviceId=${encodeURIComponent(approverDeviceId)}`,
      { method: 'GET' },
    );
  }

  approvePairing(pairingId: string, request: Record<string, unknown>): Promise<SyncPairing> {
    return this.json(`/api/sync/pairings/${encodeURIComponent(pairingId)}/approve`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  registerPairingPackage(pairingId: string, approverDeviceId: string): Promise<SyncPairing> {
    return this.json(
      `/api/sync/pairings/${encodeURIComponent(pairingId)}/register-package?approverDeviceId=${encodeURIComponent(approverDeviceId)}`,
      { method: 'POST' },
    );
  }

  getPairing(pairingId: string, requestedDeviceId: string): Promise<SyncPairing> {
    return this.json(
      `/api/sync/pairings/${encodeURIComponent(pairingId)}?requestedDeviceId=${encodeURIComponent(requestedDeviceId)}`,
      { method: 'GET' },
    );
  }

  completePairing(pairingId: string, request: Record<string, unknown>): Promise<SyncPairing> {
    return this.json(`/api/sync/pairings/${encodeURIComponent(pairingId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  initiateKeyPackage(request: Record<string, unknown>): Promise<SyncKeyPackage> {
    return this.json('/api/sync/key-packages/initiate', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  registerKeyPackage(keyPackageId: string, creatorDeviceId: string): Promise<SyncKeyPackage> {
    return this.json(
      `/api/sync/key-packages/${encodeURIComponent(keyPackageId)}/register?creatorDeviceId=${encodeURIComponent(creatorDeviceId)}`,
      { method: 'POST' },
    );
  }

  getLatestRecoveryPackage(): Promise<SyncKeyPackage> {
    return this.json('/api/sync/key-packages/recovery/latest', { method: 'GET' });
  }

  getRecoveryStatus(): Promise<SyncRecovery> {
    return this.json('/api/sync/recovery', { method: 'GET' });
  }

  listDeviceKeyPackages(deviceId: string): Promise<SyncKeyPackage[]> {
    return this.json(`/api/sync/key-packages/device?deviceId=${encodeURIComponent(deviceId)}`, {
      method: 'GET',
    });
  }

  applyDeviceKeyPackage(
    keyPackageId: string,
    deviceId: string,
    possessionSignature: string,
  ): Promise<SyncKeyPackage> {
    return this.json(`/api/sync/key-packages/${encodeURIComponent(keyPackageId)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ deviceId, possessionSignature }),
    });
  }

  beginRecovery(request: Record<string, unknown>): Promise<SyncRecovery> {
    return this.json('/api/sync/recovery/begin', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  approveRecovery(attemptId: string, recoveryDeviceId: string): Promise<SyncRecovery> {
    return this.json(
      `/api/sync/recovery/approve?attemptId=${encodeURIComponent(attemptId)}&recoveryDeviceId=${encodeURIComponent(recoveryDeviceId)}`,
      { method: 'POST' },
    );
  }

  getRecoveryPackage(attemptId: string, recoveryDeviceId: string): Promise<SyncRecovery> {
    return this.json(
      `/api/sync/recovery/package?attemptId=${encodeURIComponent(attemptId)}&recoveryDeviceId=${encodeURIComponent(recoveryDeviceId)}`,
      { method: 'GET' },
    );
  }

  markRecoveryKeyPersisted(
    attemptId: string,
    request: Record<string, unknown>,
  ): Promise<SyncRecovery> {
    return this.json(
      `/api/sync/recovery/key-persisted?attemptId=${encodeURIComponent(attemptId)}`,
      { method: 'POST', body: JSON.stringify(request) },
    );
  }

  finalizeRecovery(attemptId: string, recoveryDeviceId: string): Promise<SyncRecovery> {
    return this.json(
      `/api/sync/recovery/finalize?attemptId=${encodeURIComponent(attemptId)}&recoveryDeviceId=${encodeURIComponent(recoveryDeviceId)}`,
      { method: 'POST' },
    );
  }

  beginRotation(
    rotationId: string,
    deviceId: string,
    revokedDeviceId?: string,
  ): Promise<SyncRotation> {
    return this.json('/api/sync/rotations/begin', {
      method: 'POST',
      body: JSON.stringify({ rotationId, deviceId, revokedDeviceId }),
    });
  }

  advanceRotation(
    rotationId: string,
    deviceId: string,
    nextStatus: string,
  ): Promise<SyncRotation> {
    return this.json(`/api/sync/rotations/${encodeURIComponent(rotationId)}/advance`, {
      method: 'POST',
      body: JSON.stringify({ deviceId, nextStatus }),
    });
  }

  commitRotationEpoch(rotationId: string, deviceId: string): Promise<SyncRotation> {
    return this.json(
      `/api/sync/rotations/${encodeURIComponent(rotationId)}/commit-epoch?deviceId=${encodeURIComponent(deviceId)}`,
      { method: 'POST' },
    );
  }

  markRotationLocalCommitted(
    rotationId: string,
    deviceId: string,
    possessionSignature: string,
  ): Promise<SyncRotation> {
    return this.json(`/api/sync/rotations/${encodeURIComponent(rotationId)}/local-committed`, {
      method: 'POST',
      body: JSON.stringify({ deviceId, possessionSignature }),
    });
  }

  getRotation(rotationId: string): Promise<SyncRotation> {
    return this.json(`/api/sync/rotations/${encodeURIComponent(rotationId)}`, { method: 'GET' });
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
      mapError: (error) => apiError || mapHttpError(error),
      retryPolicy: { maxAttempts: init.method === 'GET' ? 3 : 1 },
    });
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }

  private async mapApiError(response: Response): Promise<SyncError> {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      /* controlled fallback */
    }
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
