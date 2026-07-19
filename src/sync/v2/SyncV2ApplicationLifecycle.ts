import type { LocalDataStore } from '../../platform/storage';
import type { DiaryRepository, RepositorySnapshot } from '../../repositories/DiaryRepository';
import type {
  GoogleAccountSession,
  LocalSyncAccountState,
  SupabaseAuthSession,
  SyncDomainEvent,
  SyncRecordType,
} from '../../types';
import {
  createInitialPin,
  createInitialPinWithRecovery,
  hasRecoveryQuestion,
} from '../../domain/security';
import { createDefaultDriveBackupSettings } from '../../repositories/defaults';
import { populateUserProfileFromGoogle } from '../../utils/googleProfile';
import {
  getConfiguredSupabaseAnonKey,
  getConfiguredSupabaseUrl,
  createConfiguredSyncV2ApiClient,
} from '../config';
import { decryptSyncPayload, encryptSyncPayload } from '../encryptedSyncObject';
import type { EventSyncEngine, SyncRuntimeDelegate } from '../eventSyncEngine';
import { refreshSupabaseSession } from '../supabaseAuth';
import {
  clearPendingPrimaryAccountSetupSecret,
  clearPendingPrimaryAccountRecoverySecret,
  clearSyncSecrets,
  decodeSyncSecretBytes,
  encodeSyncSecretBytes,
  loadPendingPrimaryAccountSetupSecret,
  loadPendingPrimaryAccountRecoverySecret,
  loadSyncSecrets,
  savePendingPrimaryAccountSetupSecret,
  savePendingPrimaryAccountRecoverySecret,
  saveSyncSecrets,
} from '../syncSecrets';
import { decodeCompanionKeyPackage, unwrapRootKeysForCompanion } from '../companionKeyPackage';
import { exportDeviceSigningPublicKeySpki, generateDeviceKeyPair } from '../deviceKeys';
import { isSyncError, SyncError } from '../errors';
import {
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  unwrapAccountRootKeysFromRecovery,
  validateExistingRecoveryPassphrase,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from '../e2eeKeyPackage';
import {
  SYNC_V2_OUTBOX_STORAGE_KEY,
  type OutboxRepository,
  type SyncOutboxOperationV2,
} from '../outbox';
import { SyncV2ApiClient } from './api/SyncV2ApiClient';
import type { SyncV2Protocol } from './api/SyncV2ApiTypes';
import { PersistentSyncConflictStore } from './conflict/PersistentSyncConflictStore';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { BoundedObjectTransfer, sha256Hex } from './operation/BoundedObjectTransfer';
import { CanonicalSyncV2OperationPreparer } from './operation/CanonicalSyncV2OperationPreparer';
import {
  PersistentOperationAcknowledgmentStore,
  type OperationAcknowledgmentStore,
} from './operation/PersistentOperationAcknowledgmentStore';
import { SyncV2OperationProcessor } from './operation/SyncV2OperationProcessor';
import {
  ProtocolBootstrap,
  SyncV2RuntimeStore,
  type SyncV2LocalRuntime,
} from './protocol/ProtocolBootstrap';
import {
  isCanaryEnabled,
  isVersionAtLeast,
  RuntimeControlStore,
} from './protocol/RuntimeControlStore';
import {
  PersistentReplayStore,
  SYNC_V2_RECORDS_KEY,
  SYNC_V2_RUNTIME_KEY,
  SYNC_V2_VERSIONS_KEY,
  type DecryptedSyncV2Event,
  type ReplayBatchEvent,
  type SyncV2ReplayStore,
} from './replay/PersistentReplayStore';
import { RemoteEventPuller } from './replay/RemoteEventPuller';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import { clearRecoverableCompanionSafetyStop } from './safety/companionSafetyRecovery';
import {
  PersistentSyncV2SnapshotStore,
  type SyncV2CanonicalSnapshotState,
} from './snapshot/PersistentSyncV2SnapshotStore';
import { AccountKeySyncV2SnapshotCodec } from './snapshot/SyncV2SnapshotCodec';
import { SyncV2SnapshotCoordinator } from './snapshot/SyncV2SnapshotCoordinator';
import { SyncV2RuntimeCoordinator, type SyncV2BackgroundWorker } from './SyncV2RuntimeCoordinator';
import {
  PersistentWorkflowJournalStore,
  SyncV2MigrationCoordinator,
} from './advanced/AdvancedWorkflowCoordinators';
import { reportUnexpectedError } from '../../infrastructure/telemetry/reportUnexpectedError';
import { signWithDeviceBundle } from './v2CompanionPairing';
import { clearSyncV2LocalCache } from './clearSyncV2LocalCache';

const PROTOCOL_VERSION = 2;
const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined)?.trim() || '1.0.0';
const MIGRATION_JOURNAL_KEY = 'deardiary_sync_v2_migration_journal';
const LEGACY_VERSIONS_KEY = 'deardiary_sync_record_versions';
const MAX_WORK_PER_FLUSH = 100;
const COMPANION_AUTHORIZATION_CHECK_INTERVAL_MS = 5_000;

const recordTypeToLegacy: Record<SyncOutboxOperationV2['recordType'], SyncRecordType> = {
  DIARY: 'diary',
  ENTRY: 'entry',
  NOTE: 'note',
  SETTINGS: 'settings',
  PROFILE: 'profile',
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
};

export const repositorySnapshotToV2State = (
  snapshot: RepositorySnapshot,
): SyncV2CanonicalSnapshotState => {
  const records: Record<string, unknown> = {};
  snapshot.diaries.forEach((value) => {
    records[`DIARY:${value.id}`] = value;
  });
  snapshot.entries.forEach((value) => {
    records[`ENTRY:${value.id}`] = value;
  });
  snapshot.notes.forEach((value) => {
    records[`NOTE:${value.id}`] = value;
  });
  if (snapshot.settings) records['SETTINGS:settings'] = snapshot.settings;
  if (snapshot.userProfile) records['PROFILE:profile'] = snapshot.userProfile;
  if (snapshot.security) records['SECURITY:security'] = snapshot.security;
  return {
    records,
    recordVersions: Object.fromEntries(Object.keys(records).map((key) => [key, 0])),
    mediaPointers: {},
  };
};

const repositorySnapshotFromV2State = (
  state: SyncV2CanonicalSnapshotState,
): RepositorySnapshot => ({
  diaries: Object.entries(state.records)
    .filter(([key]) => key.startsWith('DIARY:'))
    .map(([, value]) => value as RepositorySnapshot['diaries'][number]),
  entries: Object.entries(state.records)
    .filter(([key]) => key.startsWith('ENTRY:'))
    .map(([, value]) => value as RepositorySnapshot['entries'][number]),
  notes: Object.entries(state.records)
    .filter(([key]) => key.startsWith('NOTE:'))
    .map(([, value]) => value as RepositorySnapshot['notes'][number]),
  settings: state.records['SETTINGS:settings'] as RepositorySnapshot['settings'],
  userProfile: state.records['PROFILE:profile'] as RepositorySnapshot['userProfile'],
  security: state.records['SECURITY:security'] as RepositorySnapshot['security'],
  syncRecordVersions: Object.fromEntries(
    Object.entries(state.recordVersions).map(([key, version]) => {
      const separator = key.indexOf(':');
      return [`${key.slice(0, separator).toLowerCase()}${key.slice(separator)}`, version];
    }),
  ),
});

const stateDigest = async (state: SyncV2CanonicalSnapshotState): Promise<string> =>
  sha256Hex(new TextEncoder().encode(canonicalJson(state)));

class MemoryDataStore implements LocalDataStore {
  private readonly values = new Map<string, string>();
  async getItem(key: string) {
    return this.values.get(key) || null;
  }
  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  async setItems(items: Record<string, string>) {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
  async clear() {
    this.values.clear();
  }
}

class IntervalWorker implements SyncV2BackgroundWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void | Promise<void>,
  ) {}
  async start(): Promise<void> {
    if (this.timer) return;
    // Startup must not report success until the first unit of work succeeds.
    // Otherwise an initial pull failure is hidden behind a running-looking UI.
    await this.task();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.task().catch(this.onError);
    }, this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class RuntimeDelegate implements SyncRuntimeDelegate {
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private authorizationTimer: ReturnType<typeof setInterval> | null = null;
  private starting: Promise<void> | null = null;
  private pullAllowed = false;
  private writesAllowed = false;
  constructor(
    private readonly coordinator: SyncV2RuntimeCoordinator,
    private readonly puller: RemoteEventPuller,
    private readonly processor: SyncV2OperationProcessor,
    private readonly assertAuthorized: (() => Promise<void>) | null,
    private readonly onError: (context: string, error: unknown) => void | Promise<void>,
  ) {}
  start(): Promise<void> {
    if (!this.starting)
      this.starting = this.coordinator
        .start()
        .then((result) => {
          this.pullAllowed = result.pullAllowed;
          this.writesAllowed = result.writesAllowed;
          if (this.assertAuthorized && !this.authorizationTimer) {
            this.authorizationTimer = setInterval(() => {
              void this.assertAuthorized!().catch((error) =>
                this.onError('sync.v2.authorization', error),
              );
            }, COMPANION_AUTHORIZATION_CHECK_INTERVAL_MS);
          }
        })
        .catch((error) => {
          this.starting = null;
          throw error;
        });
    return this.starting;
  }
  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.authorizationTimer) clearInterval(this.authorizationTimer);
    this.flushTimer = null;
    this.authorizationTimer = null;
    await this.coordinator.stop();
    this.starting = null;
    this.pullAllowed = false;
    this.writesAllowed = false;
  }
  async pullPending(): Promise<void> {
    try {
      await this.start();
      if (this.pullAllowed) await this.puller.pull();
    } catch (error) {
      await this.onError('sync.v2.pull', error);
      throw error;
    }
  }
  async flushPendingOutbox(): Promise<void> {
    try {
      await this.start();
      if (!this.writesAllowed) return;
      for (
        let count = 0;
        count < MAX_WORK_PER_FLUSH && (await this.processor.runOnce());
        count += 1
      ) {
        /* bounded drain */
      }
    } catch (error) {
      await this.onError('sync.v2.outbox', error);
      throw error;
    }
  }
  requestOutboxFlush(delayMs = 0): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingOutbox().catch(() => undefined);
    }, delayMs);
  }
}

class RepositoryReplayStore implements SyncV2ReplayStore {
  constructor(
    private readonly persistent: PersistentReplayStore,
    private readonly repository: DiaryRepository,
  ) {}
  getLastAppliedSequence() {
    return this.persistent.getLastAppliedSequence();
  }
  hasAppliedEvent(eventId: string) {
    return this.persistent.hasAppliedEvent(eventId);
  }
  async applyBatch(events: ReplayBatchEvent[]): Promise<number> {
    for (const { envelope, event } of events) {
      await this.repository.applySyncEvent(
        toDomainEvent(envelope.deviceId, envelope.eventId, event),
        envelope.sequence,
      );
    }
    return this.persistent.applyBatch(events);
  }
}

const toDomainEvent = (
  deviceId: string,
  eventId: string,
  event: DecryptedSyncV2Event,
): SyncDomainEvent =>
  ({
    version: 1,
    eventId,
    accountId: event.accountId,
    deviceId,
    createdAt: new Date().toISOString(),
    operation:
      event.operationType === 'DELETE' ? 'delete' : event.recordVersion === 1 ? 'create' : 'update',
    recordType: recordTypeToLegacy[event.recordType],
    recordId: event.recordId,
    baseRecordVersion: event.recordVersion - 1,
    recordVersion: event.recordVersion,
    payload: event.payload,
  }) as SyncDomainEvent;

class RepositoryAcknowledgmentStore implements OperationAcknowledgmentStore {
  constructor(
    private readonly persistent: PersistentOperationAcknowledgmentStore,
    private readonly repository: DiaryRepository,
    private readonly store: LocalDataStore,
  ) {}
  async acknowledge(
    operation: SyncOutboxOperationV2,
    result: Parameters<OperationAcknowledgmentStore['acknowledge']>[1],
  ): Promise<void> {
    const payload = await loadRecord(this.repository, operation);
    const event = toDomainEvent(operation.deviceId, operation.operationId, {
      accountId: operation.accountId,
      operationId: operation.operationId,
      recordType: operation.recordType,
      recordId: operation.recordId,
      operationType: operation.operationType,
      recordVersion: result.recordVersion,
      keyEpoch: operation.keyEpoch || 1,
      payload,
    });
    await this.repository.acknowledgeLocalMutation({ event, sequence: result.sequence });
    await this.persistent.acknowledge(operation, result);
    const raw = await this.store.getItem(SYNC_V2_RECORDS_KEY);
    const records = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const key = `${operation.recordType}:${operation.recordId}`;
    if (operation.operationType === 'DELETE') delete records[key];
    else records[key] = payload;
    await this.store.setItem(SYNC_V2_RECORDS_KEY, JSON.stringify(records));
    await this.repository.removeSyncOutboxOperation(operation.operationId);
  }
}

const loadRecord = async (
  repository: DiaryRepository,
  operation: SyncOutboxOperationV2,
): Promise<unknown | null> => {
  switch (operation.recordType) {
    case 'DIARY':
      return repository.getDiary(operation.recordId);
    case 'ENTRY':
      return repository.getEntry(operation.recordId);
    case 'NOTE':
      return repository.getNote(operation.recordId);
    case 'SETTINGS':
      return repository.getSettings();
    case 'PROFILE':
      return repository.getUserProfile();
  }
};

export interface SyncV2LifecycleStatus {
  mode: 'NOT_CONFIGURED' | 'V1' | 'MIGRATING' | 'V2';
  eligible: boolean;
  reason?: string;
  rolloutPercentage?: number;
  featureFlags?: SyncV2Protocol['featureFlags'];
}

export interface CreatePrimarySyncAccountInput {
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  recoveryPassphrase: string;
  localPin: string;
  recoveryQuestion: { questionId: string; answer: string; questionText?: string };
  onProgress?: (message: string) => void;
}

interface PendingPrimaryAccountSetup {
  version: 1;
  googleUserId: string;
  googleEmail: string;
  deviceId: string;
  devicePublicKey: string;
  devicePrivateKeyJwk: string;
  accountRootKeyBase64: string;
  recoveryPackageId: string;
  accountId?: string;
  recoveryPackageBase64?: string;
  recoveryPackageSha256?: string;
}

interface PendingPrimaryAccountRecovery {
  version: 1;
  googleUserId: string;
  googleEmail: string;
  attemptId: string;
  deviceId: string;
  devicePublicKey: string;
  devicePrivateKeyJwk: string;
  recoveryPackageBase64?: string;
}

export class SyncV2ApplicationLifecycle {
  private delegate: RuntimeDelegate | null = null;
  private api: SyncV2ApiClient | null = null;
  private revocationHandling: Promise<void> | null = null;
  private readonly companionRecoveryAttempts = new Set<string>();

  constructor(
    private readonly store: LocalDataStore,
    private readonly repository: DiaryRepository,
    private readonly outbox: OutboxRepository,
    private readonly legacyEngine: EventSyncEngine,
  ) {}

  async hasExistingPrimaryAccount(supabaseSession: SupabaseAuthSession): Promise<boolean> {
    if (!supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    const api = createConfiguredSyncV2ApiClient(async () => supabaseSession.accessToken);
    try {
      await api.getRecoveryStatus();
      return true;
    } catch (error) {
      if (isSyncError(error) && error.code === 'OBJECT_MISSING') return false;
      throw error;
    }
  }

  async recoverPrimaryAccount(
    input: CreatePrimarySyncAccountInput,
  ): Promise<LocalSyncAccountState> {
    if (!input.googleSession.email)
      throw new Error('Google must return an email address to restore your Dear Diary account.');
    if (!input.supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    if (await this.repository.getLocalSyncAccountState())
      throw new Error('Sync & Backup is already configured on this device.');
    validateExistingRecoveryPassphrase(input.recoveryPassphrase);

    const api = createConfiguredSyncV2ApiClient(async () => input.supabaseSession.accessToken);
    input.onProgress?.('Checking your encrypted account...');
    const protocol = await api.getProtocol();
    if (!protocol.featureFlags.primaryRecoveryEnabled || !protocol.featureFlags.remotePullEnabled) {
      throw new Error('Account recovery is temporarily unavailable. Try again later.');
    }

    let pending = await loadPendingPrimaryAccountRecoverySecret<PendingPrimaryAccountRecovery>();
    if (
      pending &&
      (pending.version !== 1 ||
        pending.googleUserId !== input.googleSession.userId ||
        pending.googleEmail.toLowerCase() !== input.googleSession.email.toLowerCase())
    ) {
      throw new Error(
        "An unfinished recovery belongs to another Google account. Clear this app's data before continuing.",
      );
    }
    if (!pending) {
      const deviceKeys = await generateDeviceKeyPair();
      pending = {
        version: 1,
        googleUserId: input.googleSession.userId,
        googleEmail: input.googleSession.email,
        attemptId: crypto.randomUUID(),
        deviceId: crypto.randomUUID(),
        devicePublicKey: deviceKeys.publicKey,
        devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
      };
      await savePendingPrimaryAccountRecoverySecret(pending);
    }

    input.onProgress?.('Authorizing this device...');
    await api.beginRecovery({
      recoveryAttemptId: pending.attemptId,
      recoveryDeviceId: pending.deviceId,
      recoveryDevicePublicKey: await exportDeviceSigningPublicKeySpki(pending.devicePublicKey),
      platform: 'android',
    });
    await api.approveRecovery(pending.attemptId, pending.deviceId);
    if (!pending.recoveryPackageBase64) {
      const recovery = await api.getRecoveryPackage(pending.attemptId, pending.deviceId);
      const recoveryPackage = recovery.recoveryPackage;
      if (!recoveryPackage?.downloadUrl || !recoveryPackage.sha256 || !recoveryPackage.sizeBytes) {
        throw new Error('The encrypted recovery package is unavailable.');
      }
      const transfer = new BoundedObjectTransfer({
        maximumObjectBytes: protocol.maximumSnapshotBytes,
      });
      const [recoveryBytes] = await transfer.download([
        {
          downloadUrl: recoveryPackage.downloadUrl,
          sha256: recoveryPackage.sha256,
          sizeBytes: recoveryPackage.sizeBytes,
        },
      ]);
      pending = { ...pending, recoveryPackageBase64: encodeSyncSecretBytes(recoveryBytes) };
      await savePendingPrimaryAccountRecoverySecret(pending);
    }

    input.onProgress?.('Unlocking your encrypted diary...');
    const keyPackage = decodeRecoveryKeyPackage(
      decodeSyncSecretBytes(pending.recoveryPackageBase64),
    );
    const recoveredKeys = await unwrapAccountRootKeysFromRecovery(
      keyPackage,
      input.recoveryPassphrase,
    );
    const accountId = keyPackage.accountId;
    const keyEpoch =
      keyPackage.keyEpoch || Math.max(...Object.keys(recoveredKeys.accountRootKeys).map(Number));
    if (
      !accountId ||
      !Number.isInteger(keyEpoch) ||
      keyEpoch < 1 ||
      !recoveredKeys.accountRootKeys[keyEpoch]
    ) {
      throw new Error('The encrypted recovery package is incomplete.');
    }

    await clearSyncV2LocalCache(this.store);
    const runtimeStore = new SyncV2RuntimeStore(this.store);
    await runtimeStore.save({
      accountId,
      deviceId: pending.deviceId,
      deviceStatus: 'RECOVERY_PENDING',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch,
      lastAppliedSequence: 0,
      updatedAt: Date.now(),
    });
    await this.store.setItems({
      [SYNC_V2_RECORDS_KEY]: '{}',
      [SYNC_V2_VERSIONS_KEY]: '{}',
      deardiary_sync_v2_media_pointers: '{}',
      deardiary_sync_v2_applied_events: '[]',
    });
    await saveSyncSecrets({
      version: 1,
      accountId,
      accountRootKey: recoveredKeys.accountRootKeys[keyEpoch],
      accountRootKeys: recoveredKeys.accountRootKeys,
      devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
      supabaseSession: input.supabaseSession,
      googleSession: input.googleSession,
    });

    input.onProgress?.('Restoring your encrypted diary...');
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: Math.max(protocol.maximumSnapshotBytes, protocol.maximumEventBytes),
    });
    const safety = new PersistentSafetyStopStore(this.store);
    const snapshotStore = new PersistentSyncV2SnapshotStore(this.store);
    const snapshots = new SyncV2SnapshotCoordinator(
      api,
      transfer,
      snapshotStore,
      new AccountKeySyncV2SnapshotCodec(async (epoch) => {
        const key = recoveredKeys.accountRootKeys[epoch];
        if (!key) throw new SyncError({ code: 'KEY_EPOCH_UNAVAILABLE', safetyRelevant: true });
        return key;
      }),
      safety,
      {
        accountId,
        deviceId: pending.deviceId,
        protocolVersion: PROTOCOL_VERSION,
        snapshotSchemaVersion: protocol.snapshotSchemaVersion,
        maximumSnapshotBytes: protocol.maximumSnapshotBytes,
        currentKeyEpoch: async () => keyEpoch,
      },
    );
    const restoredSnapshot = await snapshots.restoreLatestWithMetadata();
    const restoredState = (await snapshotStore.exportAccountState(accountId)).state;
    const restoredRepositorySnapshot = repositorySnapshotFromV2State(restoredState);
    await this.repository.importSnapshot(restoredRepositorySnapshot, 'replace-portable');

    const recoveredAccount: LocalSyncAccountState = {
      accountId,
      syncProtocolVersion: 2,
      deviceId: pending.deviceId,
      deviceRole: 'primary_mobile',
      googleUserId: input.googleSession.userId,
      googleEmail: input.googleSession.email,
      devicePublicKey: pending.devicePublicKey,
      recoveryKeyDriveFileId: '',
      latestSnapshotDriveFileId: '',
      latestSnapshotSequence: restoredSnapshot.throughSequence,
      currentSyncSequence: restoredSnapshot.throughSequence,
      keyEpoch,
      linkedAt: Date.now(),
    };
    await this.repository.saveLocalSyncAccountState(recoveredAccount);

    const validator = new SyncInvariantValidator();
    const replay = new RepositoryReplayStore(
      new PersistentReplayStore(this.store, validator),
      this.repository,
    );
    const puller = new RemoteEventPuller(
      api,
      transfer,
      {
        hasKeyEpoch: async (epoch) => Boolean(recoveredKeys.accountRootKeys[epoch]),
        decrypt: async (bytes, epoch) => {
          const key = recoveredKeys.accountRootKeys[epoch];
          if (!key) throw new SyncError({ code: 'KEY_EPOCH_UNAVAILABLE', safetyRelevant: true });
          const decrypted = await decryptSyncPayload(key, bytes);
          if (decrypted.objectKind !== 'event')
            throw new Error('Downloaded encrypted object is not a diary event.');
          return JSON.parse(new TextDecoder().decode(decrypted.payload)) as DecryptedSyncV2Event;
        },
      },
      replay,
      validator,
      safety,
      this.repository,
      {
        accountId,
        deviceId: pending.deviceId,
        eventSchemaVersion: protocol.eventSchemaVersion,
        replayBatchSize: 1,
      },
    );
    let currentSequence: number;
    try {
      currentSequence = await puller.pull();
    } catch (error) {
      await this.repository.clearLocalSyncAccountState();
      throw error;
    }
    // The temporary account marker is only needed by repository replay. Do not
    // expose the recovered account as configured until server finalization succeeds.
    await this.store.removeItem('deardiary_sync_account');

    input.onProgress?.('Securing this device...');
    const existingSecurity = await this.repository.getSecurityConfig();
    const localPinSecurity = existingSecurity.isPinCreated
      ? existingSecurity
      : createInitialPin(existingSecurity, input.localPin);
    const recoveredSecurity = restoredRepositorySnapshot.security;
    const recoveryMetadata = hasRecoveryQuestion(localPinSecurity)
      ? localPinSecurity
      : recoveredSecurity && hasRecoveryQuestion(recoveredSecurity)
        ? recoveredSecurity
        : null;
    const security = {
      ...localPinSecurity,
      ...(recoveryMetadata
        ? {
            recoveryQuestionId: recoveryMetadata.recoveryQuestionId,
            recoveryQuestionText: recoveryMetadata.recoveryQuestionText,
            recoveryAnswerHash: recoveryMetadata.recoveryAnswerHash,
            recoveryAnswerSalt: recoveryMetadata.recoveryAnswerSalt,
            recoveryAnswerIterations: recoveryMetadata.recoveryAnswerIterations,
          }
        : {}),
      isLocked: false,
    };
    await this.repository.saveSecurityConfig({
      ...security,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleBoundAt: Date.now(),
    });
    const backup = createDefaultDriveBackupSettings();
    await this.repository.saveDriveBackupSettings({
      ...backup,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleDisplayName: input.googleSession.displayName,
      linkedAt: Date.now(),
      cloudWriteBlocked: false,
    });

    const proof = await signWithDeviceBundle(
      pending.devicePrivateKeyJwk,
      `recovery-key-persisted:${pending.attemptId}:${restoredSnapshot.snapshotId}`,
    );
    await api.markRecoveryKeyPersisted(pending.attemptId, {
      recoveryDeviceId: pending.deviceId,
      validationSnapshotId: restoredSnapshot.snapshotId,
      possessionSignature: proof,
    });
    await api.finalizeRecovery(pending.attemptId, pending.deviceId);

    const account: LocalSyncAccountState = {
      ...recoveredAccount,
      currentSyncSequence: currentSequence,
    };
    await this.repository.saveLocalSyncAccountState(account);
    await runtimeStore.save({
      ...(await runtimeStore.load())!,
      deviceStatus: 'ACTIVE',
      lastAppliedSequence: currentSequence,
      updatedAt: Date.now(),
    });
    await clearPendingPrimaryAccountRecoverySecret();
    await this.startIfActive();
    return account;
  }

  async createPrimaryAccount(input: CreatePrimarySyncAccountInput): Promise<LocalSyncAccountState> {
    if (!input.googleSession.email)
      throw new Error('Google must return an email address to create a Dear Diary account.');
    if (!input.supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    if (await this.repository.getLocalSyncAccountState())
      throw new Error('Sync & Backup is already configured on this device.');
    validateRecoveryPassphrase(input.recoveryPassphrase);

    const api = createConfiguredSyncV2ApiClient(async () => input.supabaseSession.accessToken);
    input.onProgress?.('Preparing secure sync...');
    const protocol = await api.getProtocol();
    if (
      !protocol.featureFlags.snapshotCreationEnabled ||
      !protocol.featureFlags.primaryRecoveryEnabled
    ) {
      throw new Error('Secure sync setup is temporarily unavailable. Try again later.');
    }

    input.onProgress?.('Creating encryption keys...');
    let pending = await loadPendingPrimaryAccountSetupSecret<PendingPrimaryAccountSetup>();
    if (
      pending &&
      (pending.version !== 1 ||
        pending.googleUserId !== input.googleSession.userId ||
        pending.googleEmail.toLowerCase() !== input.googleSession.email.toLowerCase())
    ) {
      throw new Error(
        "An unfinished setup belongs to another Google account. Clear this app's data before continuing.",
      );
    }
    if (!pending) {
      const accountRootKey = generateAccountRootKey();
      const deviceKeys = await generateDeviceKeyPair();
      pending = {
        version: 1,
        googleUserId: input.googleSession.userId,
        googleEmail: input.googleSession.email,
        deviceId: crypto.randomUUID(),
        devicePublicKey: deviceKeys.publicKey,
        devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
        accountRootKeyBase64: encodeSyncSecretBytes(accountRootKey),
        recoveryPackageId: crypto.randomUUID(),
      };
      await savePendingPrimaryAccountSetupSecret(pending);
    }
    const accountRootKey = decodeSyncSecretBytes(pending.accountRootKeyBase64);
    const deviceId = pending.deviceId;
    const registration = await api.registerDevice({
      deviceId,
      devicePublicKey: await exportDeviceSigningPublicKeySpki(pending.devicePublicKey),
      deviceRole: 'PRIMARY',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      initialKeyEpoch: 1,
    });
    if (pending.accountId && pending.accountId !== registration.accountId) {
      throw new Error(
        "Secure account setup returned an unexpected account. Clear this app's data before continuing.",
      );
    }
    if (!pending.accountId) {
      pending = { ...pending, accountId: registration.accountId };
      await savePendingPrimaryAccountSetupSecret(pending);
    }

    input.onProgress?.('Personalizing your diary...');
    const profile = await populateUserProfileFromGoogle(
      await this.repository.getUserProfile(),
      input.googleSession,
    );
    await this.repository.saveUserProfile(profile);
    const security = createInitialPinWithRecovery(
      await this.repository.getSecurityConfig(),
      input.localPin,
      input.recoveryQuestion.questionId,
      input.recoveryQuestion.answer,
      input.recoveryQuestion.questionText,
    );
    await this.repository.saveSecurityConfig({
      ...security,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleBoundAt: Date.now(),
    });
    const backup = createDefaultDriveBackupSettings();
    await this.repository.saveDriveBackupSettings({
      ...backup,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleDisplayName: input.googleSession.displayName,
      linkedAt: Date.now(),
      cloudWriteBlocked: false,
    });

    const account: LocalSyncAccountState = {
      accountId: registration.accountId,
      syncProtocolVersion: 2,
      deviceId,
      deviceRole: 'primary_mobile',
      googleUserId: input.googleSession.userId,
      googleEmail: input.googleSession.email,
      devicePublicKey: pending.devicePublicKey,
      recoveryKeyDriveFileId: '',
      latestSnapshotDriveFileId: '',
      currentSyncSequence: 0,
      keyEpoch: 1,
      linkedAt: Date.now(),
    };
    await this.seedV2State(account, registration.accountId, protocol);

    input.onProgress?.('Securing account recovery...');
    if (!pending.recoveryPackageBase64 || !pending.recoveryPackageSha256) {
      const recoveryBytes = encodeRecoveryKeyPackage(
        await wrapAccountRootKeyForRecovery(accountRootKey, input.recoveryPassphrase, {
          accountId: registration.accountId,
          keyEpoch: 1,
          keyVersion: 1,
          accountRootKeys: { 1: accountRootKey },
        }),
      );
      pending = {
        ...pending,
        recoveryPackageBase64: encodeSyncSecretBytes(recoveryBytes),
        recoveryPackageSha256: await sha256Hex(recoveryBytes),
      };
      await savePendingPrimaryAccountSetupSecret(pending);
    }
    const recoveryBytes = decodeSyncSecretBytes(pending.recoveryPackageBase64);
    const recoveryPackageId = pending.recoveryPackageId;
    const recoverySha256 = pending.recoveryPackageSha256;
    const recoveryUpload = await api.initiateKeyPackage({
      keyPackageId: recoveryPackageId,
      creatorDeviceId: deviceId,
      targetDeviceId: deviceId,
      keyEpoch: 1,
      purpose: 'RECOVERY',
      sha256: recoverySha256,
      sizeBytes: recoveryBytes.byteLength,
      packageSchemaVersion: 1,
    });
    if (!recoveryUpload.upload) throw new Error('Secure recovery storage is unavailable.');
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: protocol.maximumSnapshotBytes,
    });
    await transfer.upload(
      [{ objectKey: recoveryUpload.upload.objectKey, bytes: recoveryBytes }],
      [recoveryUpload.upload],
    );
    await api.registerKeyPackage(recoveryPackageId, deviceId);

    input.onProgress?.('Creating your encrypted restore point...');
    const snapshots = new SyncV2SnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncV2SnapshotStore(this.store),
      new AccountKeySyncV2SnapshotCodec(async (epoch) => {
        if (epoch !== 1)
          throw new SyncError({ code: 'KEY_EPOCH_UNAVAILABLE', safetyRelevant: true });
        return accountRootKey;
      }),
      new PersistentSafetyStopStore(this.store),
      {
        accountId: registration.accountId,
        deviceId,
        protocolVersion: PROTOCOL_VERSION,
        snapshotSchemaVersion: protocol.snapshotSchemaVersion,
        maximumSnapshotBytes: protocol.maximumSnapshotBytes,
        currentKeyEpoch: async () => 1,
      },
    );
    await snapshots.create();
    input.onProgress?.('Finishing secure setup...');
    await saveSyncSecrets({
      version: 1,
      accountId: registration.accountId,
      accountRootKey,
      accountRootKeys: { 1: accountRootKey },
      devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
      supabaseSession: input.supabaseSession,
      googleSession: input.googleSession,
    });
    await this.repository.saveLocalSyncAccountState(account);
    await clearPendingPrimaryAccountSetupSecret();
    await this.startIfActive();
    return account;
  }

  async getStatus(options: { resetClient?: boolean } = {}): Promise<SyncV2LifecycleStatus> {
    if (options.resetClient) this.api = null;
    const account = await this.repository.getLocalSyncAccountState();
    if (!account)
      return {
        mode: 'NOT_CONFIGURED',
        eligible: false,
        reason: 'Encrypted sync is not configured.',
      };
    if (await this.store.getItem(MIGRATION_JOURNAL_KEY))
      return { mode: 'MIGRATING', eligible: true };
    if (account.syncProtocolVersion === 2) return { mode: 'V2', eligible: true };
    if (account.deviceRole !== 'primary_mobile')
      return {
        mode: 'V1',
        eligible: false,
        reason: 'Migration must be started on the primary mobile device.',
      };
    try {
      const protocol = await this.client().getProtocol();
      const eligibility = await this.migrationEligibility(account, protocol);
      return {
        mode: 'V1',
        ...eligibility,
        rolloutPercentage: protocol.syncV2RolloutPercentage,
        featureFlags: protocol.featureFlags,
      };
    } catch (error) {
      return {
        mode: 'V1',
        eligible: false,
        reason:
          error instanceof Error ? error.message : 'Sync V2 availability could not be checked.',
      };
    }
  }

  async migrateToV2(): Promise<void> {
    if (await this.store.getItem(MIGRATION_JOURNAL_KEY)) {
      await this.resumeAfterUnlock();
      return;
    }
    const account = await this.requireV1Primary();
    const api = this.client();
    const protocol = await api.getProtocol();
    const eligibility = await this.migrationEligibility(account, protocol);
    if (!eligibility.eligible) throw new Error(eligibility.reason);
    const registration = await this.registerV2Device(account);
    const v2AccountId = registration.accountId;
    await this.seedV2State(account, v2AccountId, protocol);
    await this.runMigration(account, v2AccountId, protocol);
    await this.startIfActive();
  }

  async resumeAfterUnlock(): Promise<void> {
    let account = await this.repository.getLocalSyncAccountState();
    if (!account) return;
    if (await this.store.getItem(MIGRATION_JOURNAL_KEY)) {
      const runtime = await new SyncV2RuntimeStore(this.store).load();
      if (!runtime)
        throw new Error('Sync V2 migration state is incomplete. Restart migration from Settings.');
      const registration = await this.registerV2Device(account);
      if (registration.accountId !== runtime.accountId) {
        throw new Error('Sync V2 registration does not match the resumable migration state.');
      }
      const protocol = await this.client().getProtocol();
      await this.runMigration(account, runtime.accountId, protocol);
      account = await this.repository.getLocalSyncAccountState();
    }
    if (account?.syncProtocolVersion === 2) await this.startIfActive();
  }

  async startIfActive(): Promise<boolean> {
    let account = await this.repository.getLocalSyncAccountState();
    if (!account || account.syncProtocolVersion !== 2) return false;
    try {
      await this.reconcileAcknowledgedOutbox();
      account = await this.applyAvailableDeviceKeyPackage(account);
      if (!this.companionRecoveryAttempts.has(account.accountId)) {
        const recovered = await clearRecoverableCompanionSafetyStop(
          this.store,
          this.outbox,
          account,
        );
        if (recovered) {
          this.companionRecoveryAttempts.add(account.accountId);
          await this.delegate?.stop();
          this.legacyEngine.installRuntimeDelegate(null);
          this.delegate = null;
        }
      }
      if (!this.delegate) this.delegate = await this.composeRuntime(account);
      this.legacyEngine.installRuntimeDelegate(this.delegate);
      await this.delegate.start();
      return true;
    } catch (error) {
      if (isSyncError(error) && error.code === 'DEVICE_REVOKED') {
        await this.handleDeviceRevoked();
        return false;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.delegate?.stop();
  }

  private async reconcileAcknowledgedOutbox(): Promise<void> {
    const raw = await this.store.getItem(SYNC_V2_OUTBOX_STORAGE_KEY);
    if (!raw) return;
    const v2Outbox = JSON.parse(raw) as Record<string, SyncOutboxOperationV2>;
    const acknowledgedIds = new Set(
      Object.values(v2Outbox)
        .filter((operation) => operation.state === 'ACKNOWLEDGED')
        .map((operation) => operation.operationId),
    );
    if (acknowledgedIds.size === 0) return;
    const legacyOutbox = await this.repository.listSyncOutboxOperations();
    for (const operation of legacyOutbox) {
      if (acknowledgedIds.has(operation.operationId)) {
        await this.repository.removeSyncOutboxOperation(operation.operationId);
      }
    }
  }

  private async handleRuntimeError(context: string, error: unknown): Promise<void> {
    if (isSyncError(error) && error.code === 'DEVICE_REVOKED') {
      await this.handleDeviceRevoked();
      return;
    }
    reportUnexpectedError(context, error);
  }

  private handleDeviceRevoked(): Promise<void> {
    if (this.revocationHandling) return this.revocationHandling;
    this.revocationHandling = (async () => {
      await this.delegate?.stop();
      this.legacyEngine.installRuntimeDelegate(null);
      this.delegate = null;
      await clearSyncSecrets();
      await this.repository.clearLocalSyncAccountState();
      await clearSyncV2LocalCache(this.store);
      await this.repository.resetContent();
      if (typeof window !== 'undefined')
        window.dispatchEvent(new CustomEvent('deardiary-device-revoked'));
    })();
    return this.revocationHandling;
  }

  private async applyAvailableDeviceKeyPackage(
    account: LocalSyncAccountState,
  ): Promise<LocalSyncAccountState> {
    const packages = await this.client().listDeviceKeyPackages(account.deviceId);
    const latest = packages[0];
    if (!latest) return account;
    if (!latest.downloadUrl || !latest.sha256 || !latest.sizeBytes) {
      throw new Error('The pending device key package is incomplete.');
    }
    const protocol = await this.client().getProtocol();
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: protocol.maximumSnapshotBytes,
    });
    const [bytes] = await transfer.download([
      {
        downloadUrl: latest.downloadUrl,
        sha256: latest.sha256,
        sizeBytes: latest.sizeBytes,
      },
    ]);
    const secrets = await loadSyncSecrets();
    if (!secrets) throw new Error('Encrypted sync keys are unavailable.');
    const unwrapped = await unwrapRootKeysForCompanion(
      decodeCompanionKeyPackage(bytes),
      account.devicePublicKey,
      secrets.devicePrivateKeyJwk,
    );
    if (unwrapped.keyEpoch !== latest.keyEpoch || unwrapped.keyEpoch < (account.keyEpoch || 1)) {
      throw new Error('The pending device key package epoch is invalid.');
    }
    await saveSyncSecrets({
      ...secrets,
      accountRootKey: unwrapped.accountRootKey,
      accountRootKeys: { ...(secrets.accountRootKeys || {}), ...unwrapped.accountRootKeys },
    });
    const updated = { ...account, keyEpoch: unwrapped.keyEpoch };
    await this.repository.saveLocalSyncAccountState(updated);
    const runtimeStore = new SyncV2RuntimeStore(this.store);
    const runtime = await runtimeStore.load();
    if (runtime)
      await runtimeStore.save({ ...runtime, keyEpoch: unwrapped.keyEpoch, updatedAt: Date.now() });
    const proof = await signWithDeviceBundle(
      secrets.devicePrivateKeyJwk,
      `key-package-applied:${latest.keyPackageId}:${latest.keyEpoch}`,
    );
    await this.client().applyDeviceKeyPackage(latest.keyPackageId, account.deviceId, proof);
    return updated;
  }

  private client(): SyncV2ApiClient {
    if (!this.api) this.api = createConfiguredSyncV2ApiClient(() => this.accessToken());
    return this.api;
  }

  private async accessToken(): Promise<string> {
    const secrets = await loadSyncSecrets();
    if (!secrets)
      throw new Error('Encrypted sync authorization is unavailable. Reconnect your account.');
    if (
      !secrets.supabaseSession.expiresAt ||
      secrets.supabaseSession.expiresAt > Math.floor(Date.now() / 1000) + 60
    ) {
      return secrets.supabaseSession.accessToken;
    }
    if (!secrets.supabaseSession.refreshToken)
      throw new Error('Encrypted sync authorization expired. Reconnect your account.');
    const supabaseSession = await refreshSupabaseSession({
      supabaseUrl: getConfiguredSupabaseUrl(),
      anonKey: getConfiguredSupabaseAnonKey(),
      refreshToken: secrets.supabaseSession.refreshToken,
    });
    await saveSyncSecrets({ ...secrets, supabaseSession });
    return supabaseSession.accessToken;
  }

  private async requireV1Primary(): Promise<LocalSyncAccountState> {
    const account = await this.repository.getLocalSyncAccountState();
    if (!account) throw new Error('Encrypted sync is not configured.');
    if (account.syncProtocolVersion === 2) throw new Error('This account already uses Sync V2.');
    if (account.deviceRole !== 'primary_mobile')
      throw new Error('Migration must be started on the primary mobile device.');
    return account;
  }

  private async registerV2Device(account: LocalSyncAccountState) {
    return this.client().registerDevice({
      deviceId: account.deviceId,
      devicePublicKey: await exportDeviceSigningPublicKeySpki(account.devicePublicKey),
      deviceRole: 'PRIMARY',
      protocolVersion: PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      initialKeyEpoch: account.keyEpoch || 1,
    });
  }

  private async migrationEligibility(
    account: LocalSyncAccountState,
    protocol: SyncV2Protocol,
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (protocol.emergencyMode)
      return { eligible: false, reason: 'Sync V2 migration is paused by the service.' };
    if (
      !(await isCanaryEnabled(
        account.accountId,
        protocol.syncV2RolloutPercentage,
        protocol.rolloutSaltVersion,
      ))
    ) {
      return {
        eligible: false,
        reason: `This account is not yet in the ${protocol.syncV2RolloutPercentage}% Sync V2 rollout.`,
      };
    }
    if (
      !protocol.featureFlags.syncWritesEnabled ||
      !protocol.featureFlags.remotePullEnabled ||
      !protocol.featureFlags.snapshotCreationEnabled
    ) {
      return {
        eligible: false,
        reason: 'The service has not enabled all migration safety controls.',
      };
    }
    if (
      PROTOCOL_VERSION < protocol.minimumReadProtocolVersion ||
      PROTOCOL_VERSION < protocol.minimumWriteProtocolVersion
    ) {
      return { eligible: false, reason: 'This app must be upgraded before migration.' };
    }
    if (!isVersionAtLeast(APP_VERSION, protocol.minimumSupportedAppVersion)) {
      return { eligible: false, reason: 'This app version is below the service minimum.' };
    }
    return { eligible: true };
  }

  private async seedV2State(
    account: LocalSyncAccountState,
    v2AccountId: string,
    protocol: SyncV2Protocol,
  ): Promise<void> {
    const state = repositorySnapshotToV2State(await this.repository.exportSnapshot());
    const runtime: SyncV2LocalRuntime = {
      accountId: v2AccountId,
      deviceId: account.deviceId,
      deviceStatus: 'ACTIVE',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch: account.keyEpoch || 1,
      lastAppliedSequence: 0,
      updatedAt: Date.now(),
    };
    await this.store.setItems({
      [SYNC_V2_RUNTIME_KEY]: JSON.stringify(runtime),
      [SYNC_V2_RECORDS_KEY]: JSON.stringify(state.records),
      [SYNC_V2_VERSIONS_KEY]: JSON.stringify(state.recordVersions),
      deardiary_sync_v2_media_pointers: '{}',
      deardiary_sync_v2_applied_events: '[]',
    });
  }

  private async runMigration(
    account: LocalSyncAccountState,
    v2AccountId: string,
    protocol: SyncV2Protocol,
  ): Promise<void> {
    const api = this.client();
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: protocol.maximumSnapshotBytes,
    });
    const safety = new PersistentSafetyStopStore(this.store);
    const codec = new AccountKeySyncV2SnapshotCodec((epoch) => this.keyForEpoch(epoch));
    const snapshotStore = new PersistentSyncV2SnapshotStore(this.store);
    const refreshCanonicalState = async (): Promise<SyncV2CanonicalSnapshotState> => {
      const state = repositorySnapshotToV2State(await this.repository.exportSnapshot());
      await this.store.setItems({
        [SYNC_V2_RECORDS_KEY]: JSON.stringify(state.records),
        [SYNC_V2_VERSIONS_KEY]: JSON.stringify(state.recordVersions),
        deardiary_sync_v2_media_pointers: '{}',
      });
      return state;
    };
    const snapshots = new SyncV2SnapshotCoordinator(api, transfer, snapshotStore, codec, safety, {
      accountId: v2AccountId,
      deviceId: account.deviceId,
      protocolVersion: PROTOCOL_VERSION,
      snapshotSchemaVersion: protocol.snapshotSchemaVersion,
      maximumSnapshotBytes: protocol.maximumSnapshotBytes,
      currentKeyEpoch: async () => account.keyEpoch || 1,
    });
    const journal = new PersistentWorkflowJournalStore<any>(this.store, MIGRATION_JOURNAL_KEY);
    const coordinator = new SyncV2MigrationCoordinator(api, journal, {
      drainV1: async () => {
        await this.legacyEngine.flushPendingOutbox();
        await this.legacyEngine.pullPending();
        const pending = await this.repository.listSyncOutboxOperations();
        if (
          pending.some((operation) => !['applied', 'conflict_preserved'].includes(operation.state))
        ) {
          throw new Error(
            'V1 still has pending or failed changes. Retry encrypted sync before migrating.',
          );
        }
      },
      canonicalDigest: async () => stateDigest(await refreshCanonicalState()),
      baselineSequence: async () => account.currentSyncSequence,
      createSnapshot: async () => {
        await refreshCanonicalState();
        return snapshots.create();
      },
      verifyTemporaryRestore: async (snapshotId) => {
        const temporary = new MemoryDataStore();
        await temporary.setItem(
          SYNC_V2_RUNTIME_KEY,
          JSON.stringify({
            ...(await new SyncV2RuntimeStore(this.store).load())!,
            lastAppliedSequence: 0,
            updatedAt: Date.now(),
          }),
        );
        const temporaryStore = new PersistentSyncV2SnapshotStore(temporary);
        const restore = new SyncV2SnapshotCoordinator(
          api,
          transfer,
          temporaryStore,
          codec,
          new PersistentSafetyStopStore(temporary),
          {
            accountId: v2AccountId,
            deviceId: account.deviceId,
            protocolVersion: PROTOCOL_VERSION,
            snapshotSchemaVersion: protocol.snapshotSchemaVersion,
            maximumSnapshotBytes: protocol.maximumSnapshotBytes,
            currentKeyEpoch: async () => account.keyEpoch || 1,
          },
        );
        await restore.restoreLatest();
        const latest = await api.getLatestSnapshot(protocol.snapshotSchemaVersion);
        if (latest.snapshotId !== snapshotId)
          throw new Error('The migration snapshot is no longer the latest snapshot.');
        return stateDigest((await temporaryStore.exportAccountState(v2AccountId)).state);
      },
      activateV2: async () => this.activateLocalV2(account, v2AccountId),
    });
    await coordinator.run(account.deviceId);
  }

  private async activateLocalV2(
    account: LocalSyncAccountState,
    v2AccountId: string,
  ): Promise<void> {
    const secrets = await loadSyncSecrets();
    if (!secrets)
      throw new Error('Encrypted sync keys are unavailable. Unlock and retry migration.');
    const activeAccount: LocalSyncAccountState = {
      ...account,
      accountId: v2AccountId,
      v1AccountId: account.v1AccountId || account.accountId,
      syncProtocolVersion: 2,
      currentSyncSequence: 0,
    };
    // Secure keys move first; the local account marker and its fresh V2 version
    // space then commit together. A crash before that atomic marker leaves the
    // migration journal resumable on V1.
    await saveSyncSecrets({ ...secrets, accountId: v2AccountId });
    await this.store.setItems({
      [LEGACY_VERSIONS_KEY]: '{}',
      deardiary_sync_account: JSON.stringify(activeAccount),
    });
  }

  private async keyForEpoch(epoch: number): Promise<Uint8Array> {
    const secrets = await loadSyncSecrets();
    if (!secrets) throw new Error('Encrypted sync keys are unavailable.');
    const epochKey = secrets.accountRootKeys?.[epoch];
    if (epochKey) return epochKey;
    const currentEpoch = (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1;
    if (epoch === currentEpoch) return secrets.accountRootKey;
    throw new SyncError({ code: 'KEY_EPOCH_UNAVAILABLE', safetyRelevant: true });
  }

  private async composeRuntime(account: LocalSyncAccountState): Promise<RuntimeDelegate> {
    const api = this.client();
    const controls = new RuntimeControlStore(this.store);
    const protocol = await api
      .getProtocol()
      .then(async (value) => {
        await controls.save(value);
        return value;
      })
      .catch(async () => controls.asProtocol(await controls.loadSafeFallback()));
    const runtime = await new SyncV2RuntimeStore(this.store).load();
    if (!runtime || runtime.accountId !== account.accountId)
      throw new Error('Sync V2 runtime state does not match the local account.');
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: Math.max(protocol.maximumEventBytes, 1),
    });
    const validator = new SyncInvariantValidator();
    const safety = new PersistentSafetyStopStore(this.store);
    const persistentReplay = new PersistentReplayStore(this.store, validator);
    const replay = new RepositoryReplayStore(persistentReplay, this.repository);
    const decryptor = {
      hasKeyEpoch: async (epoch: number) => {
        const secrets = await loadSyncSecrets();
        const currentEpoch = (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1;
        return Boolean(secrets && (epoch === currentEpoch || secrets.accountRootKeys?.[epoch]));
      },
      decrypt: async (bytes: Uint8Array, epoch: number): Promise<DecryptedSyncV2Event> => {
        const decrypted = await decryptSyncPayload(await this.keyForEpoch(epoch), bytes);
        if (decrypted.objectKind !== 'event')
          throw new Error('Downloaded Sync V2 object is not an event.');
        return JSON.parse(new TextDecoder().decode(decrypted.payload)) as DecryptedSyncV2Event;
      },
    };
    const puller = new RemoteEventPuller(
      api,
      transfer,
      decryptor,
      replay,
      validator,
      safety,
      this.repository,
      {
        accountId: account.accountId,
        deviceId: account.deviceId,
        eventSchemaVersion: protocol.eventSchemaVersion,
        replayBatchSize: 1,
      },
    );
    const preparer = new CanonicalSyncV2OperationPreparer({
      eventSchemaVersion: protocol.eventSchemaVersion,
      loadAuthoritativeRecord: (operation) => loadRecord(this.repository, operation),
      determinePartitionKey: async () => 'account',
      currentKeyEpoch: async () =>
        (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1,
      validateEvent: (event) => {
        if (event.accountId !== account.accountId || event.deviceId !== account.deviceId)
          throw new Error('Sync V2 event identity mismatch.');
      },
      encryptEvent: async (event, epoch) =>
        (
          await encryptSyncPayload(
            await this.keyForEpoch(epoch),
            'event',
            new TextEncoder().encode(canonicalJson(event)),
            { keyEpoch: epoch },
          )
        ).bytes,
    });
    const acknowledgments = new RepositoryAcknowledgmentStore(
      new PersistentOperationAcknowledgmentStore(this.store),
      this.repository,
      this.store,
    );
    const processor = new SyncV2OperationProcessor(
      this.outbox,
      api,
      transfer,
      preparer,
      acknowledgments,
      new PersistentSyncConflictStore(this.store),
      validator,
      safety,
      {
        accountId: account.accountId,
        deviceId: account.deviceId,
        protocolVersion: PROTOCOL_VERSION,
        workerId: `app:${account.deviceId}`,
      },
    );
    const handleWorkerError = (context: string) => (error: unknown) =>
      this.handleRuntimeError(context, error);
    const pullWorker = new IntervalWorker(
      async () => {
        await puller.pull();
      },
      90_000,
      handleWorkerError('sync.v2.pull.worker'),
    );
    const outboxWorker = new IntervalWorker(
      async () => {
        for (let count = 0; count < MAX_WORK_PER_FLUSH && (await processor.runOnce()); count += 1) {
          /* bounded drain */
        }
      },
      30_000,
      handleWorkerError('sync.v2.outbox.worker'),
    );
    const bootstrap = new ProtocolBootstrap(
      new SyncV2RuntimeStore(this.store),
      api,
      this.outbox,
      this.repository,
      safety,
      PROTOCOL_VERSION,
      Date.now,
      APP_VERSION,
      account.v1AccountId || account.accountId,
      controls,
    );
    const assertAuthorized =
      account.deviceRole === 'web_companion'
        ? async () => {
            await api.listDeviceKeyPackages(account.deviceId);
          }
        : null;
    return new RuntimeDelegate(
      new SyncV2RuntimeCoordinator(bootstrap, pullWorker, outboxWorker),
      puller,
      processor,
      assertAuthorized,
      (context, error) => this.handleRuntimeError(context, error),
    );
  }
}
