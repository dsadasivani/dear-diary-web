import { localDataStore } from '../../platform/storage';
import { diaryRepository } from '../../repositories';
import type { RepositorySnapshot } from '../../repositories/DiaryRepository';
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
  createConfiguredSyncV2ApiClient,
} from '../config';
import { refreshSupabaseSession } from '../supabaseAuth';
import {
  clearPendingV2PairingApprovalSecret,
  clearPendingV2PairingSecret,
  getAccountRootKeyForEpoch,
  loadPendingV2PairingApprovalSecret,
  loadPendingV2PairingSecret,
  loadSyncSecrets,
  savePendingV2PairingApprovalSecret,
  savePendingV2PairingSecret,
  saveSyncSecrets,
  type SyncSecrets,
} from '../syncSecrets';
import type { WebGoogleSyncSession } from '../webGoogleAuth';
import {
  SyncV2PairingCoordinator,
  type WorkflowJournalStore,
} from './advanced/AdvancedWorkflowCoordinators';
import type { SyncV2Pairing } from './api/SyncV2ApiTypes';
import { BoundedObjectTransfer } from './operation/BoundedObjectTransfer';
import { SyncV2RuntimeStore } from './protocol/ProtocolBootstrap';
import { PersistentSafetyStopStore } from './safety/PersistentSafetyStopStore';
import {
  PersistentSyncV2SnapshotStore,
  type SyncV2CanonicalSnapshotState,
} from './snapshot/PersistentSyncV2SnapshotStore';
import { AccountKeySyncV2SnapshotCodec } from './snapshot/SyncV2SnapshotCodec';
import { SyncV2SnapshotCoordinator } from './snapshot/SyncV2SnapshotCoordinator';
import { clearSyncV2LocalCache } from './clearSyncV2LocalCache';

const PROTOCOL_VERSION = 2;

interface PairingJournal {
  pairingId: string;
  requestedDeviceId: string;
  privateKeyHandle: string;
  pairingCode: string;
  challenge: string;
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
    loadPendingV2PairingSecret,
    savePendingV2PairingSecret,
    clearPendingV2PairingSecret,
  );

const approvalJournal = () =>
  new SecretJournal<PairingApprovalJournal>(
    loadPendingV2PairingApprovalSecret,
    savePendingV2PairingApprovalSecret,
    clearPendingV2PairingApprovalSecret,
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
    download: async (pairing: Pick<SyncV2Pairing, 'downloadUrl' | 'sha256' | 'sizeBytes'>) => {
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

const repositorySnapshotFromV2 = (state: SyncV2CanonicalSnapshotState): RepositorySnapshot => {
  const values = (prefix: string) =>
    Object.entries(state.records)
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([, value]) => value);
  return {
    diaries: values('DIARY') as RepositorySnapshot['diaries'],
    entries: values('ENTRY') as RepositorySnapshot['entries'],
    notes: values('NOTE') as RepositorySnapshot['notes'],
    settings: state.records['SETTINGS:settings'] as RepositorySnapshot['settings'],
    userProfile: state.records['PROFILE:profile'] as RepositorySnapshot['userProfile'],
    syncRecordVersions: Object.fromEntries(
      Object.entries(state.recordVersions).map(([key, version]) => {
        const [type, ...id] = key.split(':');
        return [`${type.toLowerCase()}:${id.join(':')}`, version];
      }),
    ),
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
  createConfiguredSyncV2ApiClient(async () => {
    if (!webAccessTokenProvider) throw new Error('Web pairing authorization is unavailable.');
    return webAccessTokenProvider();
  });

export const requestSyncV2CompanionPairing = async (auth: WebGoogleSyncSession) => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const api = optionsApi();
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.companionPairingEnabled)
    throw new Error('Sync V2 companion pairing is not enabled by the service.');
  const coordinator = new SyncV2PairingCoordinator(
    api,
    requestJournal(),
    pairingCrypto({}),
    transferAdapter(protocol.maximumSnapshotBytes),
    approvalJournal(),
  );
  const existing = await requestJournal().load();
  if (existing) {
    const remote = await api
      .getPairing(existing.pairingId, existing.requestedDeviceId)
      .catch(() => null);
    if (!remote || remote.status === 'EXPIRED' || remote.status === 'REJECTED')
      await requestJournal().clear();
  }
  const requested = await coordinator.request(crypto.randomUUID(), 'web');
  const remote = await api.getPairing(requested.pairingId, requested.requestedDeviceId);
  return { ...requested, expiresAt: remote.expiresAt };
};

export const getPendingSyncV2CompanionPairing = async (auth: WebGoogleSyncSession) => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const pending = await requestJournal().load();
  if (!pending) return null;
  const pairing = await optionsApi().getPairing(pending.pairingId, pending.requestedDeviceId);
  return {
    pairing,
    pairingCode: pending.pairingCode,
    requestedDeviceId: pending.requestedDeviceId,
  };
};

export const listPendingSyncV2Pairings = async (
  approverDeviceId: string,
): Promise<SyncV2Pairing[]> => {
  const api = createConfiguredSyncV2ApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  if (!protocol.featureFlags.companionPairingEnabled)
    throw new Error('Sync V2 companion pairing is not enabled by the service.');
  return api.listPendingPairings(approverDeviceId);
};

export const approveSyncV2CompanionPairing = async (
  pairing: SyncV2Pairing,
  pairingCode: string,
): Promise<void> => {
  const [state, secrets, security] = await Promise.all([
    diaryRepository.getLocalSyncAccountState(),
    loadSyncSecrets(),
    diaryRepository.getSecurityConfig(),
  ]);
  if (
    !state ||
    state.syncProtocolVersion !== 2 ||
    state.deviceRole !== 'primary_mobile' ||
    !secrets
  ) {
    throw new Error('Only the active Sync V2 primary mobile can approve this companion.');
  }
  if (pairing.accountId !== state.accountId)
    throw new Error('Pairing request belongs to another Sync V2 account.');
  const api = createConfiguredSyncV2ApiClient(primaryAccessToken);
  const protocol = await api.getProtocol();
  const staleApproval = await approvalJournal().load();
  if (staleApproval && staleApproval.pairingId !== pairing.pairingId) {
    // The encrypted bytes are bound to the old device public key and pairing
    // identifier, so they must never be reused for a newer request.
    await approvalJournal().clear();
  }
  const coordinator = new SyncV2PairingCoordinator(
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

export const completeSyncV2CompanionPairing = async (
  auth: WebGoogleSyncSession,
): Promise<LocalSyncAccountState | null> => {
  webAccessTokenProvider = async () => auth.supabaseSession.accessToken;
  const api = optionsApi();
  const pending = await requestJournal().load();
  if (!pending) throw new Error('No secure Sync V2 pairing request is available.');
  const remote = await api.getPairing(pending.pairingId, pending.requestedDeviceId);
  if (remote.status === 'REQUESTED') return null;
  if (remote.status === 'EXPIRED' || remote.status === 'REJECTED')
    throw new Error('Pairing request expired.');
  const protocol = await api.getProtocol();
  let unwrapped: Awaited<ReturnType<typeof unwrapRootKeysForCompanion>> | null = null;
  let privateKey = '';
  const coordinator = new SyncV2PairingCoordinator(
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
    if (!unwrapped) throw new Error('The Sync V2 key package could not be opened.');
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
    await clearSyncV2LocalCache(localDataStore);
    await saveSyncSecrets({
      version: 1,
      accountId: completed.accountId,
      accountRootKey: keys.accountRootKey,
      accountRootKeys: keys.accountRootKeys,
      devicePrivateKeyJwk: privateKey,
      supabaseSession: auth.supabaseSession,
      googleSession: auth.googleSession,
    });
    await new SyncV2RuntimeStore(localDataStore).save({
      accountId: completed.accountId,
      deviceId: completed.requestedDeviceId,
      deviceStatus: 'ACTIVE',
      protocolVersion: PROTOCOL_VERSION,
      eventSchemaVersion: protocol.eventSchemaVersion,
      keyEpoch: keys.keyEpoch,
      lastAppliedSequence: 0,
      updatedAt: Date.now(),
    });
    const stateStore = new PersistentSyncV2SnapshotStore(localDataStore);
    const snapshots = new SyncV2SnapshotCoordinator(
      api,
      new BoundedObjectTransfer({ maximumObjectBytes: protocol.maximumSnapshotBytes }),
      stateStore,
      new AccountKeySyncV2SnapshotCodec(
        async (epoch) => keys.accountRootKeys[epoch] || keys.accountRootKey,
      ),
      new PersistentSafetyStopStore(localDataStore),
      {
        accountId: completed.accountId,
        deviceId: completed.requestedDeviceId,
        protocolVersion: PROTOCOL_VERSION,
        snapshotSchemaVersion: protocol.snapshotSchemaVersion,
        maximumSnapshotBytes: protocol.maximumSnapshotBytes,
        currentKeyEpoch: async () => keys.keyEpoch,
      },
    );
    const throughSequence = await snapshots.restoreLatest();
    const restored = await stateStore.exportAccountState(completed.accountId);
    await diaryRepository.importSnapshot(
      repositorySnapshotFromV2(restored.state),
      'replace-portable',
    );
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
      syncProtocolVersion: 2,
      deviceId: completed.requestedDeviceId,
      deviceRole: 'web_companion',
      googleUserId: auth.googleSession.userId,
      googleEmail: auth.googleSession.email || '',
      devicePublicKey,
      recoveryKeyDriveFileId: '',
      latestSnapshotDriveFileId: '',
      latestSnapshotSequence: throughSequence,
      currentSyncSequence: throughSequence,
      keyEpoch: keys.keyEpoch,
      linkedAt: Date.now(),
    };
    await diaryRepository.saveLocalSyncAccountState(localState);
  });
  return diaryRepository.getLocalSyncAccountState();
};
