import { localDataStore } from '../../platform/storage';
import { diaryRepository } from '../../repositories';
import type { LocalSyncAccountState, SecurityConfig } from '../../types';
import {
  decodeCompanionKeyPackage,
  encodeCompanionKeyPackage,
  unwrapRootKeysForCompanion,
  wrapRootKeyForCompanion,
} from '../companionKeyPackage';
import {
  exportDeviceSigningPublicKeySpki,
  generateDeviceKeyPair,
  parseDevicePrivateKeyBundle,
} from '../deviceKeys';
import {
  getConfiguredSupabaseAnonKey,
  getConfiguredSupabaseUrl,
  createConfiguredSyncApiClient,
} from '../config';
import { refreshSupabaseSession } from '../supabaseAuth';
import {
  clearPendingSyncPairingApprovalSecret,
  clearPendingSyncPairingSecret,
  getAccountRootKeyForEpoch,
  loadPendingSyncPairingApprovalSecret,
  loadPendingSyncPairingSecret,
  loadSyncSecrets,
  savePendingSyncPairingApprovalSecret,
  savePendingSyncPairingSecret,
  saveSyncSecrets,
  type SyncSecrets,
} from '../syncSecrets';
import type { WebGoogleSyncSession } from '../webGoogleAuth';
import {
  SyncPairingCoordinator,
  type WorkflowJournalStore,
} from './advanced/AdvancedWorkflowCoordinators';
import type { SyncPairing } from './api/SyncApiTypes';
import { BoundedObjectTransfer } from './operation/BoundedObjectTransfer';
import { SyncRuntimeStore } from './protocol/ProtocolBootstrap';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import { PersistentSyncSnapshotStore } from './snapshot/PersistentSyncSnapshotStore';
import { AccountKeySyncSnapshotCodec } from './snapshot/SyncSnapshotCodec';
import { SyncSnapshotCoordinator } from './snapshot/SyncSnapshotCoordinator';
import { clearSyncLocalCache } from './clearSyncLocalCache';
import { createAtomicRepositorySnapshotReplacement } from './RepositorySnapshotAdapter';
import { isSyncError } from '../errors';
import { decryptSyncPayload } from '../encryptedSyncObject';
import { SyncInvariantValidator } from './domain/SyncInvariantValidator';
import { PersistentReplayStore, type DecryptedSyncEvent } from './replay/PersistentReplayStore';
import { RepositoryReplayStore } from './replay/RepositoryReplayStore';
import { RemoteEventPuller } from './replay/RemoteEventPuller';
import { TERMINAL_SYNC_OPERATION_STATES } from '../outbox';

const PROTOCOL_VERSION = 4;

interface PairingJournal {
  pairingId: string;
  requestedDeviceId: string;
  privateKeyHandle: string;
  pairingCode: string;
  challenge: string;
  bootstrapId?: string;
}

interface PairingApprovalJournal {
  pairingId: string;
  keyPackageId: string;
  encryptedBase64: string;
  sha256: string;
}

class SecretJournal<T> implements WorkflowJournalStore<T> {
  constructor(
    private readonly loadValue: () => Promise<T | null>,
    private readonly saveValue: (value: T) => Promise<void>,
    private readonly clearValue: () => Promise<void>,
  ) {}
  load(): Promise<T | null> {
    return this.loadValue();
  }
  save(value: T): Promise<void> {
    return this.saveValue(value);
  }
  clear(): Promise<void> {
    return this.clearValue();
  }
}

const requestJournal = () =>
  new SecretJournal<PairingJournal>(
    loadPendingSyncPairingSecret,
    savePendingSyncPairingSecret,
    clearPendingSyncPairingSecret,
  );

const approvalJournal = () =>
  new SecretJournal<PairingApprovalJournal>(
    loadPendingSyncPairingApprovalSecret,
    savePendingSyncPairingApprovalSecret,
    clearPendingSyncPairingApprovalSecret,
  );

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const randomChallenge = (): string => bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));

export const ecdsaP1363ToDer = (signature: Uint8Array): Uint8Array => {
  if (signature.byteLength !== 64) return signature;
  const integer = (value: Uint8Array): Uint8Array => {
    let offset = 0;
    while (offset < value.length - 1 && value[offset] === 0) offset += 1;
    const trimmed = value.slice(offset);
    const prefixed = trimmed[0] & 0x80 ? Uint8Array.of(0, ...trimmed) : trimmed;
    return Uint8Array.of(0x02, prefixed.length, ...prefixed);
  };
  const r = integer(signature.slice(0, 32));
  const s = integer(signature.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
};

export const signWithDeviceBundle = async (
  privateKeyBundle: string,
  message: string,
): Promise<string> => {
  const bundle = parseDevicePrivateKeyBundle(privateKeyBundle);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    bundle.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = ecdsaP1363ToDer(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(message),
      ),
    ),
  );
  return bytesToBase64(signature);
};

const primaryAccessToken = async (): Promise<string> => {
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
};

const transferAdapter = (maximumBytes: number) => {
  const transfer = new BoundedObjectTransfer({ maximumObjectBytes: maximumBytes });
  return {
    upload: async (
      bytes: Uint8Array,
      instruction: Parameters<BoundedObjectTransfer['upload']>[1][number],
    ) => {
      await transfer.upload([{ objectKey: instruction.objectKey, bytes }], [instruction]);
    },
    download: async (pairing: Pick<SyncPairing, 'downloadUrl' | 'sha256' | 'sizeBytes'>) => {
      if (!pairing.downloadUrl || !pairing.sha256 || !pairing.sizeBytes)
        throw new Error('Pairing package metadata is incomplete.');
      const [bytes] = await transfer.download([
        {
          downloadUrl: pairing.downloadUrl,
          sha256: pairing.sha256,
          sizeBytes: pairing.sizeBytes,
        },
      ]);
      return bytes;
    },
  };
};

const pairingCrypto = (options: {
  primarySecrets?: SyncSecrets;
  primaryState?: LocalSyncAccountState;
  primarySecurity?: SecurityConfig;
  onUnwrapped?: (
    result: Awaited<ReturnType<typeof unwrapRootKeysForCompanion>>,
    privateKey: string,
  ) => void;
}) => ({
  createDeviceKey: async () => {
    const keys = await generateDeviceKeyPair();
    return {
      signingPublicKey: await exportDeviceSigningPublicKeySpki(keys.publicKey),
      encryptionPublicKey: keys.publicKey,
      privateKeyHandle: keys.privateKeyJwk,
    };
  },
  randomChallenge: async () => randomChallenge(),
  sign: signWithDeviceBundle,
  approvalSignature: async (message: string) => {
    if (!options.primarySecrets) throw new Error('Primary device signing keys are unavailable.');
    return signWithDeviceBundle(options.primarySecrets.devicePrivateKeyJwk, message);
  },
  encryptKeyPackage: async (requestedPublicKey: string) => {
    if (
      !options.primarySecrets ||
      !options.primaryState ||
      !options.primarySecurity?.isPinCreated
    ) {
      throw new Error('Primary encryption keys and PIN verification are required.');
    }
    const epoch = options.primaryState.keyEpoch || 1;
    const rootKey = getAccountRootKeyForEpoch(options.primarySecrets, epoch);
    return encodeCompanionKeyPackage(
      await wrapRootKeyForCompanion(rootKey, options.primaryState.accountId, requestedPublicKey, {
        keyEpoch: epoch,
        accountRootKeys: { ...(options.primarySecrets.accountRootKeys || {}), [epoch]: rootKey },
        pinVerifier: {
          version: 1,
          pinHash: options.primarySecurity.pinHash,
          pinSalt: options.primarySecurity.pinSalt,
          pinLength: options.primarySecurity.pinLength || 4,
        },
      }),
    );
  },
  decryptAndPersist: async (
    privateKey: string,
    encrypted: Uint8Array,
    requestedPublicKey: string,
  ) => {
    const result = await unwrapRootKeysForCompanion(
      decodeCompanionKeyPackage(encrypted),
      requestedPublicKey,
      privateKey,
    );
    options.onUnwrapped?.(result, privateKey);
  },
});

let webAccessTokenProvider: (() => Promise<string>) | null = null;
const optionsApi = () =>
  createConfiguredSyncApiClient(async () => {
    if (!webAccessTokenProvider) throw new Error('Web pairing authorization is unavailable.');
    return webAccessTokenProvider();
  });

export const requestSyncCompanionPairing = async (auth: WebGoogleSyncSession) => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const api = optionsApi();
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.companionPairingEnabled)
    throw new Error('Loredays Sync companion pairing is not enabled by the service.');
  const coordinator = new SyncPairingCoordinator(
    api,
    requestJournal(),
    pairingCrypto({}),
    transferAdapter(protocol.maximumSnapshotBytes),
    approvalJournal(),
  );
  const existing = await requestJournal().load();
  if (existing) {
    let remote: SyncPairing | null = null;
    try {
      remote = await api.getPairing(existing.pairingId, existing.requestedDeviceId);
    } catch (error) {
      if (!isSyncError(error) || error.code !== 'PAIRING_NOT_FOUND') throw error;
    }
    if (!remote || remote.status === 'EXPIRED' || remote.status === 'REJECTED')
      await requestJournal().clear();
  }
  const requested = await coordinator.request(crypto.randomUUID(), 'web');
  const remote = await api.getPairing(requested.pairingId, requested.requestedDeviceId);
  return { ...requested, expiresAt: remote.expiresAt };
};

export const getPendingSyncCompanionPairing = async (auth: WebGoogleSyncSession) => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const pending = await requestJournal().load();
  if (!pending) return null;
  let pairing: SyncPairing;
  try {
    pairing = await optionsApi().getPairing(pending.pairingId, pending.requestedDeviceId);
  } catch (error) {
    if (!isSyncError(error) || error.code !== 'PAIRING_NOT_FOUND') throw error;
    await requestJournal().clear();
    return null;
  }
  return {
    pairing,
    pairingCode: pending.pairingCode,
    requestedDeviceId: pending.requestedDeviceId,
  };
};

export const listPendingSyncPairings = async (
  approverDeviceId: string,
): Promise<SyncPairing[]> => {
  const api = createConfiguredSyncApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.companionPairingEnabled)
    throw new Error('Loredays Sync companion pairing is not enabled by the service.');
  return api.listPendingPairings(approverDeviceId);
};

export const approveSyncCompanionPairing = async (
  pairing: SyncPairing,
  pairingCode: string,
): Promise<void> => {
  const [state, secrets, security] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(),
    loadSyncSecrets(),
    diaryRepository.getSecurityConfig(),
  ]);
  if (
    !state ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets
  ) {
    throw new Error('Only the active Loredays Sync primary mobile can approve this companion.');
  }
  if (pairing.accountId !== state.accountId)
    throw new Error('Pairing request belongs to another Loredays Sync account.');
  const api = createConfiguredSyncApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  if (protocol.bootstrapControls?.bootstrapManifestEnabled) {
    const readiness = await api.getBootstrapReadiness(state.deviceId);
    if (readiness.snapshotRequired) {
      const pendingOperations = await diaryRepository.listSyncOutboxOperations();
      if (
        pendingOperations.some((operation) => !TERMINAL_SYNC_OPERATION_STATES.has(operation.state))
      ) {
        throw new Error('Finish syncing pending diary changes before preparing this companion.');
      }
      const runtime = await new SyncRuntimeStore(localDataStore).load();
      if (!runtime || runtime.accountId !== state.accountId) {
        throw new Error('The local sync cursor is unavailable for snapshot preparation.');
      }
      await api.acknowledgeCursor(state.deviceId, runtime.appliedSequence);
      const snapshots = new SyncSnapshotCoordinator(
        api,
        new BoundedObjectTransfer({
          maximumObjectBytes: protocol.maximumSnapshotBytes,
          maximumConcurrency: 6,
        }),
        new PersistentSyncSnapshotStore(localDataStore),
        new AccountKeySyncSnapshotCodec((epoch) =>
          Promise.resolve(getAccountRootKeyForEpoch(secrets, epoch)),
        ),
        new PersistentSafetyStopStore(localDataStore),
        {
          accountId: state.accountId,
          deviceId: state.deviceId,
          protocolVersion: PROTOCOL_VERSION,
          snapshotSchemaVersion: protocol.snapshotSchemaVersion,
          maximumSnapshotBytes: protocol.maximumSnapshotBytes,
          currentKeyEpoch: async () => state.keyEpoch || 1,
          signMetadata: (message) => signWithDeviceBundle(secrets.devicePrivateKeyJwk, message),
        },
      );
      await snapshots.create();
    }
  }
  const staleApproval = await approvalJournal().load();
  if (staleApproval && staleApproval.pairingId !== pairing.pairingId) {
    // The encrypted bytes are bound to the old device public key and pairing
    // identifier, so they must never be reused for a newer request.
    await approvalJournal().clear();
  }
  const coordinator = new SyncPairingCoordinator(
    api,
    requestJournal(),
    pairingCrypto({ primarySecrets: secrets, primaryState: state, primarySecurity: security }),
    transferAdapter(protocol.maximumSnapshotBytes),
    approvalJournal(),
  );
  await coordinator.approve({
    pairingId: pairing.pairingId,
    requestedDeviceId: pairing.requestedDeviceId,
    requestedPublicKey: pairing.requestedDeviceEncryptionPublicKey,
    challenge: pairing.challenge,
    pairingCode,
    approverDeviceId: state.deviceId,
    keyEpoch: state.keyEpoch || 1,
  });
};

export const completeSyncCompanionPairing = async (
  auth: WebGoogleSyncSession,
): Promise<LocalSyncAccountState | null> => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const api = optionsApi();
  const pending = await requestJournal().load();
  if (!pending) throw new Error('No secure Loredays Sync pairing request is available.');
  const remote = await api.getPairing(pending.pairingId, pending.requestedDeviceId);
  if (remote.status === 'REQUESTED' || remote.status === 'SNAPSHOT_PREPARING') return null;
  if (remote.status === 'EXPIRED' || remote.status === 'REJECTED')
    throw new Error('Pairing request expired.');
  const protocol = await api.getProtocol();
  const bootstrapEnabled = protocol.bootstrapControls?.bootstrapManifestEnabled === true;
  if (bootstrapEnabled && !pending.bootstrapId) {
    pending.bootstrapId = crypto.randomUUID();
    await requestJournal().save(pending);
  }
  let unwrapped: Awaited<ReturnType<typeof unwrapRootKeysForCompanion>> | null = null;
  let privateKey = '';
  const coordinator = new SyncPairingCoordinator(
    api,
    requestJournal(),
    pairingCrypto({
      onUnwrapped: (result, key) => {
        unwrapped = result;
        privateKey = key;
      },
    }),
    transferAdapter(protocol.maximumSnapshotBytes),
    approvalJournal(),
  );
  await coordinator.complete(async (completed) => {
    if (!unwrapped) throw new Error('The Loredays Sync key package could not be opened.');
    const keys = unwrapped as Awaited<ReturnType<typeof unwrapRootKeysForCompanion>>;
    if (!keys.pinVerifier) {
      throw new Error(
        'The companion package does not contain mobile PIN verification. Revoke it and pair again.',
      );
    }
    const devicePublicKey = completed.requestedDeviceEncryptionPublicKey;
    // A revoked browser can pair again with a new device identity. Its former
    // canonical cache is no longer authorized and must not block the new
    // snapshot restore. This also makes a failed completion retry-safe.
    await clearSyncLocalCache(localDataStore);
    await saveSyncSecrets({
      accountId: completed.accountId,
      accountRootKey: keys.accountRootKey,
      accountRootKeys: keys.accountRootKeys,
      devicePrivateKeyJwk: privateKey,
      supabaseSession: auth.supabaseSession,
      googleSession: auth.googleSession,
    });
    await new SyncRuntimeStore(localDataStore).save({
      accountId: completed.accountId,
      deviceId: completed.requestedDeviceId,
      deviceStatus: bootstrapEnabled ? 'RECOVERY_PENDING' : 'ACTIVE',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch: keys.keyEpoch,
      appliedSequence: 0,
      updatedAt: Date.now(),
    });
    const stateStore = new PersistentSyncSnapshotStore(
      localDataStore,
      Date.now,
      createAtomicRepositorySnapshotReplacement(diaryRepository),
    );
    const transfer = new BoundedObjectTransfer({
      maximumObjectBytes: Math.max(protocol.maximumSnapshotBytes, protocol.maximumEventBytes),
      maximumConcurrency: 6,
    });
    const safety = new PersistentSafetyStopStore(localDataStore);
    const snapshots = new SyncSnapshotCoordinator(
      api,
      transfer,
      stateStore,
      new AccountKeySyncSnapshotCodec(
        async (epoch) => keys.accountRootKeys[epoch] || keys.accountRootKey,
      ),
      safety,
      {
        accountId: completed.accountId,
        deviceId: completed.requestedDeviceId,
        protocolVersion: PROTOCOL_VERSION,
        snapshotSchemaVersion: protocol.snapshotSchemaVersion,
        maximumSnapshotBytes: protocol.maximumSnapshotBytes,
        currentKeyEpoch: async () => keys.keyEpoch,
      },
    );
    const manifest = bootstrapEnabled
      ? await api.createBootstrap({
          bootstrapId: pending.bootstrapId!,
          deviceId: completed.requestedDeviceId,
          pairingId: pending.pairingId,
        })
      : null;
    if (manifest) {
      await diaryRepository.updateSyncCatchUpStatus({
        catchUpPhase: 'restoring-snapshot',
        startingSequence: manifest.snapshot.throughSequence,
        snapshotSequence: manifest.snapshot.throughSequence,
        appliedSequence: 0,
        targetSequence: manifest.headSequence,
        totalEvents: manifest.tailCount,
      });
    }
    const throughSequence = manifest
      ? (await snapshots.restoreSnapshot(manifest.snapshot)).throughSequence
      : await snapshots.restoreLatest();
    await diaryRepository.saveSecurityConfig({
      isPinCreated: true,
      pinHash: keys.pinVerifier.pinHash,
      pinSalt: keys.pinVerifier.pinSalt,
      pinLength: keys.pinVerifier.pinLength,
      isBiometricsEnabled: false,
      isLocked: true,
      linkedGoogleUserId: auth.googleSession.userId,
      linkedGoogleEmail: auth.googleSession.email || null,
      linkedGoogleBoundAt: Date.now(),
    });
    const localState: LocalSyncAccountState = {
      accountId: completed.accountId,
      deviceId: completed.requestedDeviceId,
      deviceRole: 'web_companion',
      googleUserId: auth.googleSession.userId,
      googleEmail: auth.googleSession.email || '',
      devicePublicKey,
      appliedSequence: throughSequence,
      keyEpoch: keys.keyEpoch,
      linkedAt: Date.now(),
    };
    await diaryRepository.saveLocalSyncAccountState(localState);
    if (manifest) {
      const validator = new SyncInvariantValidator();
      const puller = new RemoteEventPuller(
        api,
        transfer,
        {
          hasKeyEpoch: async (epoch) => Boolean(keys.accountRootKeys[epoch] || keys.accountRootKey),
          decrypt: async (bytes, epoch): Promise<DecryptedSyncEvent> => {
            const decrypted = await decryptSyncPayload(
              keys.accountRootKeys[epoch] || keys.accountRootKey,
              bytes,
            );
            if (decrypted.objectKind !== 'event') {
              throw new Error('Downloaded Loredays Sync object is not an event.');
            }
            return JSON.parse(new TextDecoder().decode(decrypted.payload)) as DecryptedSyncEvent;
          },
        },
        new RepositoryReplayStore(
          new PersistentReplayStore(localDataStore),
          diaryRepository,
        ),
        validator,
        safety,
        diaryRepository,
        {
          accountId: completed.accountId,
          deviceId: completed.requestedDeviceId,
          eventSchemaVersion: protocol.eventSchemaVersion,
          pageSize: 100,
          replayBatchSize: protocol.bootstrapControls?.replayBatchSize || 25,
          throughSequence: manifest.headSequence,
          onProgress: (progress) =>
            diaryRepository.updateSyncCatchUpStatus({
              catchUpPhase: progress.phase,
              startingSequence: progress.startingSequence,
              snapshotSequence: progress.snapshotSequence,
              appliedSequence: progress.appliedSequence,
              targetSequence: progress.targetSequence,
              downloadedEvents: progress.downloadedEvents,
              appliedEvents: progress.appliedEvents,
              totalEvents: progress.totalEvents,
              catchUpErrorCode: progress.errorCode,
              catchUpError: progress.error,
              catchUpRecoverable: progress.recoverable,
            }),
        },
      );
      await puller.pull();
      await diaryRepository.updateSyncCatchUpStatus({
        catchUpPhase: 'opening',
        startingSequence: manifest.snapshot.throughSequence,
        snapshotSequence: manifest.snapshot.throughSequence,
        appliedSequence: manifest.headSequence,
        targetSequence: manifest.headSequence,
        appliedEvents: manifest.tailCount,
        totalEvents: manifest.tailCount,
      });
      const possessionSignature = await signWithDeviceBundle(
        privateKey,
        `bootstrap-complete:${manifest.bootstrapId}:${manifest.headSequence}`,
      );
      await api.completeBootstrap(manifest.bootstrapId, {
        deviceId: completed.requestedDeviceId,
        appliedThroughSequence: manifest.headSequence,
        possessionSignature,
      });
      const runtimeStore = new SyncRuntimeStore(localDataStore);
      const runtime = await runtimeStore.load();
      if (!runtime) throw new Error('Companion bootstrap runtime is unavailable.');
      await runtimeStore.save({ ...runtime, deviceStatus: 'ACTIVE', updatedAt: Date.now() });
      await diaryRepository.saveLocalSyncAccountState({
        ...localState,
        appliedSequence: manifest.headSequence,
      });
      await diaryRepository.updateSyncCatchUpStatus({
        catchUpPhase: 'complete',
        startingSequence: manifest.snapshot.throughSequence,
        snapshotSequence: manifest.snapshot.throughSequence,
        appliedSequence: manifest.headSequence,
        targetSequence: manifest.headSequence,
        appliedEvents: manifest.tailCount,
        totalEvents: manifest.tailCount,
      });
    }
  });
  return diaryRepository.getLocalSyncAccountState();
};
