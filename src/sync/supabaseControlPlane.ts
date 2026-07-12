import type {
  DeviceRevocation,
  KeyEpochRotation,
  PairingPlatform,
  PairingSession,
  PairingSessionDetails,
  PrimaryRecoveryAttempt,
  SyncAccount,
  SyncDevice,
  SyncDeviceCursor,
  SyncObjectKind,
  SyncObjectMetadata,
  SyncPartitionCursor,
  SyncPartitionHead,
  SyncRecordType,
  SyncAffectedRecordVersion,
} from '../types';
import { measureAsync } from '../utils/performance';

export interface SupabaseControlPlaneConfig {
  url: string;
  anonKey: string;
  accessToken?: string | (() => Promise<string | null> | string | null);
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CreatePrimaryMobileInput {
  googleUserId: string;
  googleEmail: string;
  displayName: string;
  platform: PairingPlatform | string;
  publicKey: string;
  recoveryConfigured: boolean;
}

export interface RegisterPrimaryTransferInput extends CreatePrimaryMobileInput {
  previousPrimaryDeviceId?: string | null;
}

export interface BeginPrimaryRecoveryInput extends RegisterPrimaryTransferInput {}

export interface FinalizePrimaryRecoveryInput {
  recoveryAttemptId: string;
  deviceId: string;
  restoredSequence: number;
}

export interface CommitSyncObjectInput {
  deviceId: string;
  afterSequence?: number;
  driveFileId: string;
  objectKind: SyncObjectKind;
  sha256: string;
  sizeBytes: number;
  recordType?: SyncRecordType;
  recordId?: string;
  baseRecordVersion?: number;
  affectedRecords?: SyncAffectedRecordVersion[];
  partitionKey?: string | null;
  affectedPartitionKeys?: string[];
  operationId?: string | null;
  keyEpoch?: number;
}

export interface CommitSyncBatchObjectInput {
  driveFileId: string;
  objectKind: SyncObjectKind;
  sha256: string;
  sizeBytes: number;
  partitionKey?: string | null;
}

export interface CommitSyncBatchInput {
  deviceId: string;
  operationId: string;
  objects: CommitSyncBatchObjectInput[];
  recordType?: SyncRecordType;
  recordId?: string;
  baseRecordVersion?: number;
  affectedRecords?: SyncAffectedRecordVersion[];
  partitionKey?: string | null;
  affectedPartitionKeys?: string[];
  keyEpoch?: number;
}

export interface CreatePairingSessionInput {
  requestedDevicePublicKey: string;
  requestedDisplayName: string;
  requestedPlatform: PairingPlatform | string;
  pairingCodeHash: string;
  expiresAt: string;
}

export interface ApprovePairingSessionInput {
  sessionId: string;
  primaryDeviceId: string;
  pairingCode: string;
  afterSequence: number;
  driveFileId: string;
  sha256: string;
  sizeBytes: number;
  keyEpoch?: number;
}

export interface UpdateCursorInput {
  deviceId: string;
  lastAppliedSequence: number;
}

export interface UpdatePartitionCursorInput {
  deviceId: string;
  partitionKey: string;
  lastAppliedSequence: number;
  hydratedAt?: string | null;
}

export interface RevokeDeviceInput {
  primaryDeviceId: string;
  deviceId: string;
  reason: string;
}

export interface BeginDeviceKeyRotationInput extends RevokeDeviceInput {}

export interface FinalizeDeviceKeyRotationInput {
  primaryDeviceId: string;
  rotationId: string;
  keyPackageSequence: number;
}

const camelAccount = (row: any): SyncAccount => ({
  id: row.id,
  googleUserId: row.google_user_id,
  googleEmail: row.google_email,
  createdAt: row.created_at,
  activePrimaryDeviceId: row.active_primary_device_id,
  currentSyncSequence: Number(row.current_sync_sequence || 0),
  currentSnapshotSequence: Number(row.current_snapshot_sequence || 0),
  currentKeyEpoch: Number(row.current_key_epoch || 1),
  partitionedSyncEnabled: Boolean(row.partitioned_sync_enabled),
  recoveryConfigured: Boolean(row.recovery_configured),
});

const camelDevice = (row: any): SyncDevice => ({
  id: row.id,
  accountId: row.account_id,
  role: row.role,
  publicKey: row.public_key,
  displayName: row.display_name,
  platform: row.platform,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at,
  replacedByDeviceId: row.replaced_by_device_id,
  activationState: row.activation_state || 'active',
});

const camelPrimaryRecoveryAttempt = (row: any): PrimaryRecoveryAttempt => ({
  id: row.id,
  accountId: row.account_id,
  deviceId: row.device_id,
  previousPrimaryDeviceId: row.previous_primary_device_id || null,
  googleUserId: row.google_user_id,
  googleEmail: row.google_email,
  displayName: row.display_name,
  platform: row.platform,
  status: row.status,
  startedAt: row.started_at,
  finalizedAt: row.finalized_at || null,
  restoredSequence: row.restored_sequence === null || row.restored_sequence === undefined
    ? null
    : Number(row.restored_sequence),
});

const camelKeyEpochRotation = (row: any): KeyEpochRotation => ({
  id: row.id,
  accountId: row.account_id,
  primaryDeviceId: row.primary_device_id,
  revokedDeviceId: row.revoked_device_id,
  reason: row.reason,
  nextKeyEpoch: Number(row.next_key_epoch),
  startingSequence: Number(row.starting_sequence || 0),
  keyPackageSequence: row.key_package_sequence === null || row.key_package_sequence === undefined
    ? null
    : Number(row.key_package_sequence),
  status: row.status,
  createdAt: row.created_at,
  finalizedAt: row.finalized_at || null,
});

const camelSyncObject = (row: any): SyncObjectMetadata => ({
  id: row.id,
  accountId: row.account_id,
  sequence: Number(row.sequence),
  driveFileId: row.drive_file_id,
  objectKind: row.object_kind,
  sha256: row.sha256,
  sizeBytes: Number(row.size_bytes),
  createdByDeviceId: row.created_by_device_id,
  createdAt: row.created_at,
  recordType: row.record_type || null,
  recordId: row.record_id || null,
  baseRecordVersion: row.base_record_version === null || row.base_record_version === undefined
    ? null
    : Number(row.base_record_version),
  recordVersion: row.record_version === null || row.record_version === undefined
    ? null
    : Number(row.record_version),
  affectedRecords: Array.isArray(row.affected_records)
    ? row.affected_records.map((record: any) => ({
        recordType: record.record_type,
        recordId: record.record_id,
        baseRecordVersion: Number(record.base_record_version),
        recordVersion: Number(record.record_version),
      }))
    : [],
  retiredAt: row.retired_at || null,
  partitionKey: row.partition_key || null,
  affectedPartitionKeys: Array.isArray(row.affected_partition_keys) ? row.affected_partition_keys : [],
  operationId: row.operation_id || null,
  keyEpoch: Number(row.key_epoch || 1),
});

const camelCursor = (row: any): SyncDeviceCursor => ({
  accountId: row.account_id,
  deviceId: row.device_id,
  lastAppliedSequence: Number(row.last_applied_sequence || 0),
  updatedAt: row.updated_at,
});

const camelPartitionCursor = (row: any): SyncPartitionCursor => ({
  accountId: row.account_id,
  deviceId: row.device_id,
  partitionKey: row.partition_key,
  lastAppliedSequence: Number(row.last_applied_sequence || 0),
  hydratedAt: row.hydrated_at || null,
  updatedAt: row.updated_at,
});

const camelPartitionHead = (row: any): SyncPartitionHead => ({
  accountId: row.account_id,
  partitionKey: row.partition_key,
  latestSnapshotSequence: Number(row.latest_snapshot_sequence || 0),
  latestEventSequence: Number(row.latest_event_sequence || 0),
  updatedAt: row.updated_at,
});

const camelPairingSession = (row: any): PairingSession => ({
  id: row.id,
  accountId: row.account_id,
  requestedDevicePublicKey: row.requested_device_public_key,
  requestedDisplayName: row.requested_display_name,
  requestedPlatform: row.requested_platform,
  pairingCodeHash: row.pairing_code_hash,
  expiresAt: row.expires_at,
  approvedByPrimaryDeviceId: row.approved_by_primary_device_id,
  approvedAt: row.approved_at,
  approvedDeviceId: row.approved_device_id,
  keyPackageDriveFileId: row.key_package_drive_file_id,
  keyPackageSha256: row.key_package_sha256,
  keyPackageSizeBytes: row.key_package_size_bytes === null || row.key_package_size_bytes === undefined
    ? null
    : Number(row.key_package_size_bytes),
});

const camelPairingDetails = (row: any): PairingSessionDetails => ({
  session: camelPairingSession(row.session),
  device: row.device ? camelDevice(row.device) : null,
  keyObject: row.key_object ? camelSyncObject(row.key_object) : null,
});

const camelRevocation = (row: any): DeviceRevocation => ({
  accountId: row.account_id,
  deviceId: row.device_id,
  reason: row.reason,
  createdAt: row.created_at,
});

const firstRow = <T>(payload: T | T[] | null): T | null => {
  if (Array.isArray(payload)) return payload[0] || null;
  return payload;
};

const DEFAULT_RPC_TIMEOUT_MS = 45_000;

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const createTimeoutSignal = (timeoutMs: number): { signal: AbortSignal; cancel: () => void } => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId),
  };
};

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export class SupabaseControlPlaneError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly providerCode?: string;

  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = 'SupabaseControlPlaneError';
    this.status = status;
    this.detail = detail;
    this.providerCode = typeof (detail as { code?: unknown } | null)?.code === 'string'
      ? (detail as { code: string }).code
      : undefined;
  }
}

export class SupabaseControlPlaneClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SupabaseControlPlaneConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || defaultFetch;
  }

  async lookupCurrentGoogleAccount(): Promise<SyncAccount | null> {
    const row = firstRow(await this.rpc<any>('lookup_google_account', {}));
    return row ? camelAccount(row) : null;
  }

  async createPrimaryMobileAccount(input: CreatePrimaryMobileInput): Promise<{ account: SyncAccount; device: SyncDevice }> {
    const row = await this.rpc<any>('create_primary_mobile_account', {
      p_google_user_id: input.googleUserId,
      p_google_email: input.googleEmail,
      p_display_name: input.displayName,
      p_platform: input.platform,
      p_public_key: input.publicKey,
      p_recovery_configured: input.recoveryConfigured,
    });
    return {
      account: camelAccount(row.account),
      device: camelDevice(row.device),
    };
  }

  async transferPrimaryMobile(input: RegisterPrimaryTransferInput): Promise<{ account: SyncAccount; device: SyncDevice; revokedDevices: SyncDevice[] }> {
    const row = await this.rpc<any>('transfer_primary_mobile', {
      p_google_user_id: input.googleUserId,
      p_google_email: input.googleEmail,
      p_display_name: input.displayName,
      p_platform: input.platform,
      p_public_key: input.publicKey,
      p_recovery_configured: input.recoveryConfigured,
      p_previous_primary_device_id: input.previousPrimaryDeviceId || null,
    });
    return {
      account: camelAccount(row.account),
      device: camelDevice(row.device),
      revokedDevices: (row.revoked_devices || []).map(camelDevice),
    };
  }

  async beginPrimaryMobileRecovery(input: BeginPrimaryRecoveryInput): Promise<{
    account: SyncAccount;
    device: SyncDevice;
    attempt: PrimaryRecoveryAttempt;
  }> {
    const row = await this.rpc<any>('begin_primary_mobile_recovery', {
      p_google_user_id: input.googleUserId,
      p_google_email: input.googleEmail,
      p_display_name: input.displayName,
      p_platform: input.platform,
      p_public_key: input.publicKey,
      p_recovery_configured: input.recoveryConfigured,
      p_previous_primary_device_id: input.previousPrimaryDeviceId || null,
    });
    return {
      account: camelAccount(row.account),
      device: camelDevice(row.device),
      attempt: camelPrimaryRecoveryAttempt(row.attempt),
    };
  }

  async finalizePrimaryMobileRecovery(input: FinalizePrimaryRecoveryInput): Promise<{
    account: SyncAccount;
    device: SyncDevice;
    attempt: PrimaryRecoveryAttempt;
    revokedDevices: SyncDevice[];
  }> {
    const row = await this.rpc<any>('finalize_primary_mobile_recovery', {
      p_recovery_attempt_id: input.recoveryAttemptId,
      p_device_id: input.deviceId,
      p_restored_sequence: input.restoredSequence,
    });
    return {
      account: camelAccount(row.account),
      device: camelDevice(row.device),
      attempt: camelPrimaryRecoveryAttempt(row.attempt),
      revokedDevices: (row.revoked_devices || []).map(camelDevice),
    };
  }

  async abortPrimaryMobileRecovery(recoveryAttemptId: string, deviceId: string): Promise<PrimaryRecoveryAttempt> {
    return camelPrimaryRecoveryAttempt(await this.rpc<any>('abort_primary_mobile_recovery', {
      p_recovery_attempt_id: recoveryAttemptId,
      p_device_id: deviceId,
    }));
  }

  async getDeviceStatus(deviceId: string): Promise<SyncDevice | null> {
    const row = firstRow(await this.rpc<any>('get_device_status', { p_device_id: deviceId }));
    return row ? camelDevice(row) : null;
  }

  async listAccountDevices(requestingDeviceId: string): Promise<SyncDevice[]> {
    const rows = await this.rpc<any[]>('list_account_devices', {
      p_requesting_device_id: requestingDeviceId,
    });
    return rows.map(camelDevice);
  }

  async commitSyncObject(input: CommitSyncObjectInput): Promise<SyncObjectMetadata> {
    const row = await this.rpc<any>('commit_sync_object', {
      p_device_id: input.deviceId,
      p_after_sequence: input.afterSequence ?? null,
      p_drive_file_id: input.driveFileId,
      p_object_kind: input.objectKind,
      p_sha256: input.sha256,
      p_size_bytes: input.sizeBytes,
      p_record_type: input.recordType || null,
      p_record_id: input.recordId || null,
      p_base_record_version: input.baseRecordVersion ?? null,
      p_affected_records: (input.affectedRecords || []).map(record => ({
        record_type: record.recordType,
        record_id: record.recordId,
        base_record_version: record.baseRecordVersion,
        record_version: record.recordVersion,
      })),
      p_partition_key: input.partitionKey || null,
      p_affected_partition_keys: input.affectedPartitionKeys || [],
      p_operation_id: input.operationId || null,
      p_key_epoch: input.keyEpoch || 1,
    });
    return camelSyncObject(row);
  }

  async commitSyncBatch(input: CommitSyncBatchInput): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('commit_sync_batch', {
      p_device_id: input.deviceId,
      p_operation_id: input.operationId,
      p_objects: input.objects.map(object => ({
        drive_file_id: object.driveFileId,
        object_kind: object.objectKind,
        sha256: object.sha256,
        size_bytes: object.sizeBytes,
        partition_key: object.partitionKey || null,
      })),
      p_record_type: input.recordType || null,
      p_record_id: input.recordId || null,
      p_base_record_version: input.baseRecordVersion ?? null,
      p_affected_records: (input.affectedRecords || []).map(record => ({
        record_type: record.recordType,
        record_id: record.recordId,
        base_record_version: record.baseRecordVersion,
        record_version: record.recordVersion,
      })),
      p_partition_key: input.partitionKey || null,
      p_affected_partition_keys: input.affectedPartitionKeys || [],
      p_key_epoch: input.keyEpoch || 1,
    });
    return rows.map(camelSyncObject);
  }

  async listSyncObjectsAfter(deviceId: string, afterSequence: number, limit = 100): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('list_sync_objects_after', {
      p_device_id: deviceId,
      p_after_sequence: afterSequence,
      p_limit: limit,
    });
    return rows.map(camelSyncObject);
  }

  async listPartitionObjectsAfter(
    deviceId: string,
    partitionKey: string,
    afterSequence: number,
    limit = 100,
  ): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('list_partition_objects_after', {
      p_device_id: deviceId,
      p_partition_key: partitionKey,
      p_after_sequence: afterSequence,
      p_limit: limit,
    });
    return rows.map(camelSyncObject);
  }

  async getLatestRestoreManifest(deviceId: string): Promise<{
    manifestObject: SyncObjectMetadata | null;
    coreSnapshotObject: SyncObjectMetadata | null;
    currentSyncSequence: number;
    keyEpoch: number;
  }> {
    const row = await this.rpc<any>('get_latest_restore_manifest', { p_device_id: deviceId });
    return {
      manifestObject: row.manifest_object ? camelSyncObject(row.manifest_object) : null,
      coreSnapshotObject: row.core_snapshot_object ? camelSyncObject(row.core_snapshot_object) : null,
      currentSyncSequence: Number(row.current_sync_sequence || 0),
      keyEpoch: Number(row.key_epoch || 1),
    };
  }

  async getPartitionRestoreBundle(deviceId: string, partitionKeys: string[]): Promise<{
    partitionKey: string;
    snapshotObject: SyncObjectMetadata | null;
    tailObjects: SyncObjectMetadata[];
  }[]> {
    const rows = await this.rpc<any[]>('get_partition_restore_bundle', {
      p_device_id: deviceId,
      p_partition_keys: partitionKeys,
    });
    return rows.map(row => ({
      partitionKey: row.partition_key,
      snapshotObject: row.snapshot_object ? camelSyncObject(row.snapshot_object) : null,
      tailObjects: (row.tail_objects || []).map(camelSyncObject),
    }));
  }

  async listAccountRecoveryObjects(): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('list_account_recovery_objects', {});
    return rows.map(camelSyncObject);
  }

  async updateDeviceCursor(input: UpdateCursorInput): Promise<SyncDeviceCursor> {
    const row = await this.rpc<any>('update_device_cursor', {
      p_device_id: input.deviceId,
      p_last_applied_sequence: input.lastAppliedSequence,
    });
    return camelCursor(row);
  }

  async updatePartitionCursor(input: UpdatePartitionCursorInput): Promise<SyncPartitionCursor> {
    const row = await this.rpc<any>('update_partition_cursor', {
      p_device_id: input.deviceId,
      p_partition_key: input.partitionKey,
      p_last_applied_sequence: input.lastAppliedSequence,
      p_hydrated_at: input.hydratedAt ?? null,
    });
    return camelPartitionCursor(row);
  }

  async listPartitionHeads(deviceId: string): Promise<SyncPartitionHead[]> {
    const rows = await this.rpc<any[]>('list_partition_heads', { p_device_id: deviceId });
    return rows.map(camelPartitionHead);
  }

  async createPairingSession(input: CreatePairingSessionInput): Promise<PairingSession> {
    const row = await this.rpc<any>('create_pairing_session', {
      p_requested_device_public_key: input.requestedDevicePublicKey,
      p_requested_display_name: input.requestedDisplayName,
      p_requested_platform: input.requestedPlatform,
      p_pairing_code_hash: input.pairingCodeHash,
      p_expires_at: input.expiresAt,
    });
    return camelPairingSession(row);
  }

  async getPairingSession(sessionId: string): Promise<PairingSessionDetails> {
    return camelPairingDetails(await this.rpc<any>('get_pairing_session', { p_session_id: sessionId }));
  }

  async listPendingPairingSessions(primaryDeviceId: string): Promise<PairingSession[]> {
    const rows = await this.rpc<any[]>('list_pending_pairing_sessions', {
      p_primary_device_id: primaryDeviceId,
    });
    return rows.map(camelPairingSession);
  }

  async approvePairingSession(input: ApprovePairingSessionInput): Promise<PairingSessionDetails> {
    const row = await this.rpc<any>('approve_pairing_session', {
      p_session_id: input.sessionId,
      p_primary_device_id: input.primaryDeviceId,
      p_pairing_code: input.pairingCode,
      p_after_sequence: input.afterSequence,
      p_drive_file_id: input.driveFileId,
      p_sha256: input.sha256,
      p_size_bytes: input.sizeBytes,
      p_key_epoch: input.keyEpoch || 1,
    });
    return camelPairingDetails(row);
  }

  async revokeDevice(input: RevokeDeviceInput): Promise<DeviceRevocation> {
    const row = await this.rpc<any>('revoke_device', {
      p_primary_device_id: input.primaryDeviceId,
      p_device_id: input.deviceId,
      p_reason: input.reason,
    });
    return camelRevocation(row);
  }

  async rotateAccountKeyEpoch(primaryDeviceId: string): Promise<number> {
    const epoch = await this.rpc<number>('rotate_account_key_epoch', {
      p_primary_device_id: primaryDeviceId,
    });
    return Number(epoch);
  }

  async beginDeviceKeyRotation(input: BeginDeviceKeyRotationInput): Promise<KeyEpochRotation> {
    return camelKeyEpochRotation(await this.rpc<any>('begin_device_key_rotation', {
      p_primary_device_id: input.primaryDeviceId,
      p_revoked_device_id: input.deviceId,
      p_reason: input.reason,
    }));
  }

  async finalizeDeviceKeyRotation(input: FinalizeDeviceKeyRotationInput): Promise<{
    account: SyncAccount;
    rotation: KeyEpochRotation;
    revocation: DeviceRevocation;
  }> {
    const row = await this.rpc<any>('finalize_device_key_rotation', {
      p_primary_device_id: input.primaryDeviceId,
      p_rotation_id: input.rotationId,
      p_key_package_sequence: input.keyPackageSequence,
    });
    return {
      account: camelAccount(row.account),
      rotation: camelKeyEpochRotation(row.rotation),
      revocation: camelRevocation(row.revocation),
    };
  }

  async abortDeviceKeyRotation(primaryDeviceId: string, rotationId: string): Promise<KeyEpochRotation> {
    return camelKeyEpochRotation(await this.rpc<any>('abort_device_key_rotation', {
      p_primary_device_id: primaryDeviceId,
      p_rotation_id: rotationId,
    }));
  }

  async retireKeyPackages(primaryDeviceId: string, driveFileIds: string[]): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('retire_key_packages', {
      p_primary_device_id: primaryDeviceId,
      p_drive_file_ids: driveFileIds,
    });
    return rows.map(camelSyncObject);
  }

  async listSyncObjectsForMaintenance(
    primaryDeviceId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('list_sync_objects_for_maintenance', {
      p_primary_device_id: primaryDeviceId,
      p_after_sequence: afterSequence,
      p_limit: limit,
    });
    return rows.map(camelSyncObject);
  }

  async retireSnapshots(primaryDeviceId: string, driveFileIds: string[]): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('retire_snapshots', {
      p_primary_device_id: primaryDeviceId,
      p_drive_file_ids: driveFileIds,
    });
    return rows.map(camelSyncObject);
  }

  async retireSyncObjects(primaryDeviceId: string, driveFileIds: string[]): Promise<SyncObjectMetadata[]> {
    const rows = await this.rpc<any[]>('retire_sync_objects', {
      p_primary_device_id: primaryDeviceId,
      p_drive_file_ids: driveFileIds,
    });
    return rows.map(camelSyncObject);
  }

  private async rpc<T>(functionName: string, payload: Record<string, unknown>): Promise<T> {
    return measureAsync('sync.supabase.rpc', async () => {
      const accessToken = typeof this.config.accessToken === 'function'
        ? await this.config.accessToken()
        : this.config.accessToken;
      const timeoutMs = this.config.timeoutMs || DEFAULT_RPC_TIMEOUT_MS;
      const timeout = createTimeoutSignal(timeoutMs);
      let response: Response;
      try {
        response = await withTimeout(
          this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${functionName}`, {
            method: 'POST',
            headers: {
              apikey: this.config.anonKey,
              Authorization: `Bearer ${accessToken || this.config.anonKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: timeout.signal,
          }),
          timeoutMs,
          `Supabase control-plane request timed out while calling ${functionName}. Check the emulator network connection and try again.`,
        );
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          throw new Error(`Supabase control-plane request timed out while calling ${functionName}. Check the emulator network connection and try again.`);
        }
        throw error;
      } finally {
        timeout.cancel();
      }

      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const message = typeof detail?.message === 'string'
          ? detail.message
          : `Supabase control-plane request failed (${response.status}).`;
        throw new SupabaseControlPlaneError(message, response.status, detail);
      }

      return response.json() as Promise<T>;
    }, { functionName, payloadKeys: Object.keys(payload).sort() });
  }
}

export const createSupabaseControlPlaneClient = (
  config: SupabaseControlPlaneConfig,
): SupabaseControlPlaneClient => new SupabaseControlPlaneClient(config);
