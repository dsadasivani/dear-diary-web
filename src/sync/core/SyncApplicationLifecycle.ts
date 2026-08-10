import type { LocalDataStore } from '../../platform/storage';
import type { DiaryRepository } from '../../repositories/DiaryRepository';
import type { GoogleAccountSession, LocalSyncAccountState, SupabaseAuthSession } from '../../types';
import { createInitialPin } from '../../domain/security';
import { populateUserProfileFromGoogle } from '../../utils/googleProfile';
import {
  getConfiguredSupabaseAnonKey,
  getConfiguredSupabaseUrl,
  createConfiguredSyncApiClient,
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
  withPrimaryRecoveryCredential,
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
  recoverDeletesBlockedByConflictedWrites,
  type OutboxRepository,
  type SyncOperation,
  TERMINAL_SYNC_OPERATION_STATES,
} from '../outbox';
import { SyncApiClient } from './api/SyncApiClient';
import type { SyncProtocol } from './api/SyncApiTypes';
import type { SyncQuota } from './api/SyncApiTypes';
import { DEFAULT_ACCOUNT_QUOTA } from '../../domain/quota';
import { PersistentSyncConflictStore } from './conflict/PersistentSyncConflictStore';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { BoundedObjectTransfer, sha256Hex } from './operation/BoundedObjectTransfer';
import { CanonicalSyncOperationPreparer } from './operation/CanonicalSyncOperationPreparer';
import { createSyncObjectKey } from './operation/CanonicalSyncOperationPreparer';
import { SyncMediaPreparer } from './media/SyncMediaPreparer';
import { SyncMediaHydrator } from './media/SyncMediaHydrator';
import {
  PersistentOperationAcknowledgmentStore,
  type OperationAcknowledgmentStore,
} from './operation/PersistentOperationAcknowledgmentStore';
import { SyncOperationProcessor } from './operation/SyncOperationProcessor';
import {
  ProtocolBootstrap,
  SyncRuntimeStore,
  type SyncLocalRuntime,
} from './protocol/ProtocolBootstrap';
import { RuntimeControlStore } from './protocol/RuntimeControlStore';
import {
  PersistentReplayStore,
  SYNC_RECORDS_KEY,
  SYNC_RUNTIME_KEY,
  SYNC_VERSIONS_KEY,
  type DecryptedSyncEvent,
} from './replay/PersistentReplayStore';
import { RepositoryReplayStore } from './replay/RepositoryReplayStore';
import { RemoteEventPuller } from './replay/RemoteEventPuller';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import { clearRecoverableCompanionSafetyStop } from './safety/companionSafetyRecovery';
import { PersistentSyncSnapshotStore } from './snapshot/PersistentSyncSnapshotStore';
import { AccountKeySyncSnapshotCodec } from './snapshot/SyncSnapshotCodec';
import { SyncSnapshotCoordinator } from './snapshot/SyncSnapshotCoordinator';
import { SyncRuntimeCoordinator, type SyncBackgroundWorker } from './SyncRuntimeCoordinator';
import { reportUnexpectedError } from '../../infrastructure/telemetry/reportUnexpectedError';
import { signWithDeviceBundle } from './companionPairing';
import { clearSyncLocalCache } from './clearSyncLocalCache';
import { signOutGoogleAuth } from '../../utils/googleAuth';
import {
  repositorySnapshotToSyncState,
  createAtomicRepositorySnapshotReplacement,
} from './RepositorySnapshotAdapter';
import { toPortableDiary, toPortableEntry, toPortableUserProfile } from '../portableMedia';
import { parseSyncMediaReference } from '../syncMedia';

const PROTOCOL_VERSION = 4;
const SYNC_QUOTA_CACHE_KEY = 'deardiary_sync_quota';
const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined)?.trim() || '1.0.0';
const MAX_WORK_PER_FLUSH = 100;
const COMPANION_AUTHORIZATION_CHECK_INTERVAL_MS = 5_000;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
};

class IntervalWorker implements SyncBackgroundWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly onError: (error: unknown) => void | Promise<void>,
  ) {}
  private run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.task().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async start(): Promise<void> {
    if (this.timer) return;
    // Startup must not report success until the first unit of work succeeds.
    // Otherwise an initial pull failure is hidden behind a running-looking UI.
    await this.run();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch(this.onError);
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
  private pullInFlight: Promise<void> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private pullAllowed = false;
  private writesAllowed = false;
  constructor(
    private readonly coordinator: SyncRuntimeCoordinator,
    private readonly puller: RemoteEventPuller,
    private readonly processor: SyncOperationProcessor,
    private readonly recoverBlockedDeletes: () => Promise<void>,
    private readonly assertAuthorized: (() => Promise<void>) | null,
    private readonly onError: (context: string, error: unknown) => void | Promise<void>,
    private readonly recoverUnknownPullStop: () => Promise<boolean>,
    private readonly mediaHydrator: SyncMediaHydrator | null,
  ) {}
  async start(): Promise<void> {
    // Coordinator startup completes its initial pull before it enables the
    // outbox worker, so this recovery probe cannot release pending writes first.
    if (await this.recoverUnknownPullStop()) await this.stop();
    if (!this.starting)
      this.starting = this.coordinator
        .start()
        .then((result) => {
          this.pullAllowed = result.pullAllowed;
          this.writesAllowed = result.writesAllowed;
          if (this.assertAuthorized && !this.authorizationTimer) {
            void this.assertAuthorized().catch((error) =>
              this.onError('sync.authorization', error),
            );
            this.authorizationTimer = setInterval(() => {
              void this.assertAuthorized!().catch((error) =>
                this.onError('sync.authorization', error),
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
    if (this.pullInFlight) return this.pullInFlight;
    this.pullInFlight = (async () => {
      try {
        await this.start();
        if (this.pullAllowed) await this.puller.pull();
      } catch (error) {
        await this.onError('sync.pull', error);
        throw error;
      } finally {
        this.pullInFlight = null;
      }
    })();
    return this.pullInFlight;
  }
  async flushPendingOutbox(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = (async () => {
      try {
        await this.start();
        if (!this.writesAllowed) return;
        if (this.pullAllowed) await this.recoverBlockedDeletes();
        for (
          let count = 0;
          count < MAX_WORK_PER_FLUSH && (await this.processor.runOnce());
          count += 1
        ) {
          /* bounded drain */
        }
      } catch (error) {
        await this.onError('sync.outbox', error);
        throw error;
      } finally {
        this.flushInFlight = null;
      }
    })();
    return this.flushInFlight;
  }
  requestOutboxFlush(delayMs = 0): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingOutbox().catch(() => undefined);
    }, delayMs);
  }
  hydrateMediaReference(reference: string): Promise<string> {
    return this.mediaHydrator?.hydrate(reference) || Promise.resolve(reference);
  }
}

class RepositoryAcknowledgmentStore implements OperationAcknowledgmentStore {
  constructor(
    private readonly persistent: PersistentOperationAcknowledgmentStore,
    private readonly repository: DiaryRepository,
  ) {}
  async acknowledge(
    operation: SyncOperation,
    result: Parameters<OperationAcknowledgmentStore['acknowledge']>[1],
  ): Promise<void> {
    // A push response proves that the server committed the mutation; it does not
    // prove that this client has integrated the corresponding ordered event.
    // Record the remote identity only. The normal pull/replay path owns record
    // versions and the applied cursor, including for events created by this device.
    for (const pointer of operation.preparedMediaPointers || []) {
      const media = operation.preparedObjects?.find(
        (object) => object.objectKey === pointer.objectKey,
      );
      const thumbnail = operation.preparedObjects?.find(
        (object) => object.objectKey === pointer.thumbnailObjectKey,
      );
      await this.repository.saveSyncMediaPointer({
        mediaId: pointer.mediaId,
        sequence: result.sequence,
        driveFileId: pointer.objectKey,
        sha256: media?.sha256 || '',
        sizeBytes: media?.sizeBytes || 0,
        createdByDeviceId: operation.deviceId,
        createdAt: new Date().toISOString(),
        localUri: pointer.localUri,
        thumbnailSequence: pointer.thumbnailObjectKey ? result.sequence : undefined,
        thumbnailDriveFileId: pointer.thumbnailObjectKey,
        thumbnailSha256: thumbnail?.sha256,
        thumbnailSizeBytes: thumbnail?.sizeBytes,
        keyEpoch: operation.keyEpoch,
      });
    }
    await this.persistent.acknowledge(operation, result);
  }
}

const loadRecord = async (
  repository: DiaryRepository,
  operation: SyncOperation,
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

export interface SyncLifecycleStatus {
  mode: 'NOT_CONFIGURED' | 'ACTIVE';
  eligible: boolean;
  reason?: string;
  featureFlags?: SyncProtocol['featureFlags'];
}

export interface CreatePrimarySyncAccountInput {
  googleSession: GoogleAccountSession;
  supabaseSession: SupabaseAuthSession;
  recoveryPassphrase: string;
  localPin: string;
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

export class SyncApplicationLifecycle {
  private delegate: RuntimeDelegate | null = null;
  private api: SyncApiClient | null = null;
  private revocationHandling: Promise<void> | null = null;
  private readonly companionRecoveryAttempts = new Set<string>();
  private readonly mediaEnabledAccounts = new Set<string>();

  constructor(
    private readonly store: LocalDataStore,
    private readonly repository: DiaryRepository,
    private readonly outbox: OutboxRepository,
    private readonly engine: EventSyncEngine,
  ) {}

  async hasExistingPrimaryAccount(supabaseSession: SupabaseAuthSession): Promise<boolean> {
    if (!supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    const api = createConfiguredSyncApiClient(async () => supabaseSession.accessToken);
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
      throw new Error('Google must return an email address to restore your Loredays account.');
    if (!input.supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    if (await this.repository.getLocalSyncAccountState())
      throw new Error('Sync & Devices is already configured on this device.');
    validateExistingRecoveryPassphrase(input.recoveryPassphrase);

    const api = createConfiguredSyncApiClient(async () => input.supabaseSession.accessToken);
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

    await clearSyncLocalCache(this.store);
    const runtimeStore = new SyncRuntimeStore(this.store);
    await runtimeStore.save({
      accountId,
      deviceId: pending.deviceId,
      deviceStatus: 'RECOVERY_PENDING',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch,
      appliedSequence: 0,
      updatedAt: Date.now(),
    });
    await this.store.setItems({
      [SYNC_RECORDS_KEY]: '{}',
      [SYNC_VERSIONS_KEY]: '{}',
      deardiary_sync_media_pointers: '{}',
      deardiary_sync_applied_events: '[]',
    });
    await saveSyncSecrets(
      withPrimaryRecoveryCredential(
        {
          accountId,
          accountRootKey: recoveredKeys.accountRootKeys[keyEpoch],
          accountRootKeys: recoveredKeys.accountRootKeys,
          devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
          supabaseSession: input.supabaseSession,
          googleSession: input.googleSession,
        },
        input.recoveryPassphrase,
      ),
    );

    input.onProgress?.('Restoring your encrypted diary...');
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: Math.max(protocol.maximumSnapshotBytes, protocol.maximumEventBytes),
      maximumConcurrency: 6,
    });
    const safety = new PersistentSafetyStopStore(this.store);
    const snapshotStore = new PersistentSyncSnapshotStore(
      this.store,
      Date.now,
      createAtomicRepositorySnapshotReplacement(this.repository),
    );
    const snapshots = new SyncSnapshotCoordinator(
      api,
      transfer,
      snapshotStore,
      new AccountKeySyncSnapshotCodec(async (epoch) => {
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
    const recoveredAccount: LocalSyncAccountState = {
      accountId,
      deviceId: pending.deviceId,
      deviceRole: 'primary_mobile',
      googleUserId: input.googleSession.userId,
      googleEmail: input.googleSession.email,
      devicePublicKey: pending.devicePublicKey,
      appliedSequence: restoredSnapshot.throughSequence,
      keyEpoch,
      linkedAt: Date.now(),
    };
    await this.repository.saveLocalSyncAccountState(recoveredAccount);

    const validator = new SyncInvariantValidator();
    const replay = new RepositoryReplayStore(
      new PersistentReplayStore(this.store),
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
          return JSON.parse(new TextDecoder().decode(decrypted.payload)) as DecryptedSyncEvent;
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
        replayBatchSize: protocol.bootstrapControls?.replayBatchSize || 25,
        onProgress: (progress) => this.engine.reportCatchUpProgress(progress),
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
    const security = {
      ...localPinSecurity,
      isLocked: false,
    };
    await this.repository.saveSecurityConfig({
      ...security,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleBoundAt: Date.now(),
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
      appliedSequence: currentSequence,
    };
    await this.repository.saveLocalSyncAccountState(account);
    await runtimeStore.save({
      ...(await runtimeStore.load())!,
      deviceStatus: 'ACTIVE',
      appliedSequence: currentSequence,
      updatedAt: Date.now(),
    });
    await clearPendingPrimaryAccountRecoverySecret();
    await this.startIfActive();
    return account;
  }

  async createPrimaryAccount(input: CreatePrimarySyncAccountInput): Promise<LocalSyncAccountState> {
    if (!input.googleSession.email)
      throw new Error('Google must return an email address to create a Loredays account.');
    if (!input.supabaseSession.accessToken)
      throw new Error('Account authorization is unavailable. Sign in again.');
    if (await this.repository.getLocalSyncAccountState())
      throw new Error('Sync & Devices is already configured on this device.');
    validateRecoveryPassphrase(input.recoveryPassphrase);

    const api = createConfiguredSyncApiClient(async () => input.supabaseSession.accessToken);
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
    const security = createInitialPin(await this.repository.getSecurityConfig(), input.localPin);
    await this.repository.saveSecurityConfig({
      ...security,
      linkedGoogleUserId: input.googleSession.userId,
      linkedGoogleEmail: input.googleSession.email,
      linkedGoogleBoundAt: Date.now(),
    });
    const account: LocalSyncAccountState = {
      accountId: registration.accountId,
      deviceId,
      deviceRole: 'primary_mobile',
      googleUserId: input.googleSession.userId,
      googleEmail: input.googleSession.email,
      devicePublicKey: pending.devicePublicKey,
      appliedSequence: 0,
      keyEpoch: 1,
      linkedAt: Date.now(),
    };
    await this.seedSyncState(account, registration.accountId, protocol);

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

    // Media must be committed before the first restore point is captured. Keep the
    // account setup journal until both the backfill and snapshot have succeeded so
    // an interrupted setup can resume with the same encrypted outbox objects.
    await saveSyncSecrets(
      withPrimaryRecoveryCredential(
        {
          accountId: registration.accountId,
          accountRootKey,
          accountRootKeys: { 1: accountRootKey },
          devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
          supabaseSession: input.supabaseSession,
          googleSession: input.googleSession,
        },
        input.recoveryPassphrase,
      ),
    );
    this.api = api;
    this.delegate = await this.composeRuntime(account);
    this.engine.installRuntimeDelegate(this.delegate);
    await this.delegate.start();
    if (this.mediaEnabledAccounts.has(account.accountId)) {
      const queued = await this.queueMediaBackfill(account);
      if (queued) await this.delegate.flushPendingOutbox();
    }
    await this.delegate.pullPending();

    input.onProgress?.('Creating your encrypted restore point...');
    const snapshots = new SyncSnapshotCoordinator(
      api,
      transfer,
      new PersistentSyncSnapshotStore(this.store),
      new AccountKeySyncSnapshotCodec(async (epoch) => {
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
        signMetadata: (message) => signWithDeviceBundle(pending.devicePrivateKeyJwk, message),
      },
    );
    await snapshots.create();
    input.onProgress?.('Finishing secure setup...');
    await this.repository.saveLocalSyncAccountState(account);
    await clearPendingPrimaryAccountSetupSecret();
    return account;
  }

  async getStatus(options: { resetClient?: boolean } = {}): Promise<SyncLifecycleStatus> {
    if (options.resetClient) this.api = null;
    const account = await this.repository.getLocalSyncAccountState();
    if (!account)
      return {
        mode: 'NOT_CONFIGURED',
        eligible: false,
        reason: 'Encrypted sync is not configured.',
      };
    return { mode: 'ACTIVE', eligible: true };
  }

  async getQuota(options: { refresh?: boolean } = {}): Promise<SyncQuota> {
    const account = await this.repository.getLocalSyncAccountState();
    if (!account) return structuredClone(DEFAULT_ACCOUNT_QUOTA);

    const loadCached = async (): Promise<SyncQuota | null> => {
      const raw = await this.store.getItem(SYNC_QUOTA_CACHE_KEY);
      if (!raw) return null;
      try {
        const cached = JSON.parse(raw) as { accountId?: string; quota?: SyncQuota };
        return cached.accountId === account.accountId && cached.quota ? cached.quota : null;
      } catch {
        return null;
      }
    };

    if (!options.refresh) {
      const cached = await loadCached();
      if (cached) return cached;
    }
    try {
      const quota = await this.client().getQuota();
      await this.store.setItem(
        SYNC_QUOTA_CACHE_KEY,
        JSON.stringify({ accountId: account.accountId, quota }),
      );
      for (const operation of await this.outbox.listByAccount(account.accountId)) {
        if (operation.state !== 'BLOCKED_QUOTA') continue;
        await this.outbox.transition(operation.operationId, 'BLOCKED_QUOTA', 'PREPARING', {
          lastErrorCode: undefined,
          lastErrorAt: undefined,
          nextAttemptAt: 0,
        });
      }
      this.engine.requestOutboxFlush();
      return quota;
    } catch (error) {
      const cached = await loadCached();
      if (cached) return cached;
      throw error;
    }
  }

  async unlinkThisCompanion(): Promise<void> {
    const [account, secrets] = await Promise.all([
      this.repository.getLocalSyncAccountState(),
      loadSyncSecrets(),
    ]);
    if (
      !account ||
      account.deviceRole !== 'web_companion' ||
      !secrets
    ) {
      throw new Error('Only a linked browser companion can unlink itself.');
    }
    const api = createConfiguredSyncApiClient(() => this.accessToken());
    const possessionSignature = await signWithDeviceBundle(
      secrets.devicePrivateKeyJwk,
      `device-revoke-self:${account.deviceId}`,
    );
    await api.revokeSelf(account.deviceId, possessionSignature);
    await signOutGoogleAuth().catch(() => undefined);
    await this.handleDeviceRevoked();
  }

  async resumeAfterUnlock(): Promise<void> {
    let account = await this.repository.getLocalSyncAccountState();
    if (!account) return;
    await this.startIfActive();
  }

  async startIfActive(): Promise<boolean> {
    let account = await this.repository.getLocalSyncAccountState();
    if (!account) return false;
    try {
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
          this.engine.installRuntimeDelegate(null);
          this.delegate = null;
        }
      }
      if (!this.delegate) this.delegate = await this.composeRuntime(account);
      this.engine.installRuntimeDelegate(this.delegate);
      await this.delegate.start();
      if (this.mediaEnabledAccounts.has(account.accountId)) {
        const queued = await this.queueMediaBackfill(account);
        if (queued) await this.delegate.flushPendingOutbox();
      }
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
      this.engine.installRuntimeDelegate(null);
      this.delegate = null;
      await clearSyncSecrets();
      await this.repository.clearLocalSyncAccountState();
      await clearSyncLocalCache(this.store);
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
    const runtimeStore = new SyncRuntimeStore(this.store);
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

  private client(): SyncApiClient {
    if (!this.api) this.api = createConfiguredSyncApiClient(() => this.accessToken());
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

  private async seedSyncState(
    account: LocalSyncAccountState,
    accountId: string,
    protocol: SyncProtocol,
  ): Promise<void> {
    const state = repositorySnapshotToSyncState(await this.repository.exportSnapshot());
    const runtime: SyncLocalRuntime = {
      accountId: accountId,
      deviceId: account.deviceId,
      deviceStatus: 'ACTIVE',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch: account.keyEpoch || 1,
      appliedSequence: 0,
      updatedAt: Date.now(),
    };
    await this.store.setItems({
      [SYNC_RUNTIME_KEY]: JSON.stringify(runtime),
      [SYNC_RECORDS_KEY]: JSON.stringify(state.records),
      [SYNC_VERSIONS_KEY]: JSON.stringify(state.recordVersions),
      deardiary_sync_media_pointers: '{}',
      deardiary_sync_applied_events: '[]',
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
    const runtime = await new SyncRuntimeStore(this.store).load();
    if (!runtime || runtime.accountId !== account.accountId)
      throw new Error('Loredays Sync runtime state does not match the local account.');
    if (protocol.featureFlags.mediaUploadEnabled) this.mediaEnabledAccounts.add(account.accountId);
    else this.mediaEnabledAccounts.delete(account.accountId);
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: Math.max(
        protocol.maximumEventBytes,
        protocol.maximumMediaBytes,
        protocol.maximumSnapshotBytes,
        1,
      ),
      maximumConcurrency: 6,
    });
    const validator = new SyncInvariantValidator();
    const safety = new PersistentSafetyStopStore(this.store);
    const persistentReplay = new PersistentReplayStore(this.store);
    const replay = new RepositoryReplayStore(
      persistentReplay,
      this.repository,
    );
    const decryptor = {
      hasKeyEpoch: async (epoch: number) => {
        const secrets = await loadSyncSecrets();
        const currentEpoch = (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1;
        return Boolean(secrets && (epoch === currentEpoch || secrets.accountRootKeys?.[epoch]));
      },
      decrypt: async (bytes: Uint8Array, epoch: number): Promise<DecryptedSyncEvent> => {
        const decrypted = await decryptSyncPayload(await this.keyForEpoch(epoch), bytes);
        if (decrypted.objectKind !== 'event')
          throw new Error('Downloaded Loredays Sync object is not an event.');
        return JSON.parse(new TextDecoder().decode(decrypted.payload)) as DecryptedSyncEvent;
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
        replayBatchSize: protocol.bootstrapControls?.replayBatchSize || 25,
        onProgress: (progress) => this.engine.reportCatchUpProgress(progress),
      },
    );
    const mediaPreparer = protocol.featureFlags.mediaUploadEnabled
      ? new SyncMediaPreparer({
          repository: this.repository,
          keyForEpoch: (epoch) => this.keyForEpoch(epoch),
          createObjectKey: createSyncObjectKey,
        })
      : undefined;
    const preparer = new CanonicalSyncOperationPreparer({
      eventSchemaVersion: protocol.eventSchemaVersion,
      loadAuthoritativeRecord: (operation) => loadRecord(this.repository, operation),
      determinePartitionKey: async () => 'account',
      currentKeyEpoch: async () =>
        (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1,
      validateEvent: (event) => {
        if (event.accountId !== account.accountId || event.deviceId !== account.deviceId)
          throw new Error('Loredays Sync event identity mismatch.');
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
      mediaPreparer,
    });
    const acknowledgments = new RepositoryAcknowledgmentStore(
      new PersistentOperationAcknowledgmentStore(this.store),
      this.repository,
    );
    const processor = new SyncOperationProcessor(
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
      handleWorkerError('sync.pull.worker'),
    );
    const outboxWorker = new IntervalWorker(
      async () => {
        for (let count = 0; count < MAX_WORK_PER_FLUSH && (await processor.runOnce()); count += 1) {
          /* bounded drain */
        }
      },
      30_000,
      handleWorkerError('sync.outbox.worker'),
    );
    const rollingSnapshotWorker = new IntervalWorker(
      async () => {
        const rollingEnabled = protocol.bootstrapControls?.rollingSnapshotsEnabled === true;
        if (!rollingEnabled || account.deviceRole !== 'primary_mobile') return;
        const readiness = await api.getBootstrapReadiness(account.deviceId);
        if (!readiness.snapshotRequired && readiness.snapshotLag < readiness.softTailEvents) return;
        await puller.pull();
        const pending = (await this.outbox.listByAccount(account.accountId)).some(
          (operation) => !TERMINAL_SYNC_OPERATION_STATES.has(operation.state),
        );
        if (pending) return;
        const secrets = await loadSyncSecrets();
        if (!secrets) throw new Error('Encrypted sync keys are unavailable.');
        const snapshots = new SyncSnapshotCoordinator(
          api,
          transfer,
          new PersistentSyncSnapshotStore(this.store),
          new AccountKeySyncSnapshotCodec((epoch) => this.keyForEpoch(epoch)),
          safety,
          {
            accountId: account.accountId,
            deviceId: account.deviceId,
            protocolVersion: PROTOCOL_VERSION,
            snapshotSchemaVersion: protocol.snapshotSchemaVersion,
            maximumSnapshotBytes: protocol.maximumSnapshotBytes,
            currentKeyEpoch: async () =>
              (await this.repository.getLocalSyncAccountState())?.keyEpoch || 1,
            signMetadata: (message) => signWithDeviceBundle(secrets.devicePrivateKeyJwk, message),
          },
        );
        await snapshots.create();
      },
      5 * 60_000,
      handleWorkerError('sync.snapshot.worker'),
    );
    const bootstrap = new ProtocolBootstrap(
      new SyncRuntimeStore(this.store),
      api,
      this.outbox,
      this.repository,
      safety,
      PROTOCOL_VERSION,
      Date.now,
      APP_VERSION,
      controls,
    );
    const assertAuthorized = async () => {
      await api.listDeviceKeyPackages(account.deviceId);
    };
    return new RuntimeDelegate(
      new SyncRuntimeCoordinator(bootstrap, pullWorker, outboxWorker, rollingSnapshotWorker),
      puller,
      processor,
      () =>
        recoverDeletesBlockedByConflictedWrites({
          accountId: account.accountId,
          repository: this.repository,
          outbox: this.outbox,
          pullLatest: () => puller.pull().then(() => undefined),
        }).then(() => undefined),
      assertAuthorized,
      (context, error) => this.handleRuntimeError(context, error),
      () => safety.clearRecoverableUnknownPull(account.accountId),
      protocol.featureFlags.mediaUploadEnabled
        ? new SyncMediaHydrator(
            api,
            this.repository,
            (epoch) => this.keyForEpoch(epoch),
            protocol.maximumMediaBytes,
            account.accountId,
          )
        : null,
    );
  }

  private async queueMediaBackfill(account: LocalSyncAccountState): Promise<boolean> {
    const marker = `deardiary_sync_media_backfill:${account.accountId}`;
    if (await this.store.getItem(marker)) return false;
    const hasLocal = (value: string | undefined): boolean =>
      Boolean(value && !parseSyncMediaReference(value));
    let queued = false;
    const [diaries, entries, profile] = await Promise.all([
      this.repository.listDiaries(),
      this.repository.listEntries(),
      this.repository.getUserProfile(),
    ]);
    for (const diary of diaries.filter((item) => hasLocal(item.coverImage))) {
      await this.repository.applyLocalMutationWithOutbox({
        operationId: crypto.randomUUID(),
        recordType: 'diary',
        recordId: diary.id,
        operation: 'upsert',
        account,
        localPayload: diary,
        syncPayload: toPortableDiary(diary),
      });
      queued = true;
    }
    for (const entry of entries.filter(
      (item) =>
        item.photoUris.some(hasLocal) ||
        hasLocal(item.audioUri) ||
        item.blocks?.some((block) => hasLocal(block.audioUri)),
    )) {
      await this.repository.applyLocalMutationWithOutbox({
        operationId: crypto.randomUUID(),
        recordType: 'entry',
        recordId: entry.id,
        operation: 'upsert',
        account,
        localPayload: entry,
        syncPayload: toPortableEntry(entry),
      });
      queued = true;
    }
    if (hasLocal(profile.avatarUri)) {
      await this.repository.applyLocalMutationWithOutbox({
        operationId: crypto.randomUUID(),
        recordType: 'profile',
        recordId: 'profile',
        operation: 'upsert',
        account,
        localPayload: profile,
        syncPayload: toPortableUserProfile(profile),
      });
      queued = true;
    }
    await this.store.setItem(marker, new Date().toISOString());
    return queued;
  }
}
