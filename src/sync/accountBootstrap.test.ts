import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DriveBackupSettings, GoogleAccountSession, PrimaryRecoveryAttempt, SecurityConfig, SyncAccount, SyncDevice, SyncObjectMetadata } from '../types';
import {
  bootstrapNewMobileAccount,
  loadPendingPrimaryRecovery,
  resumePendingPrimaryRecovery,
  type PendingPrimaryRecovery,
} from './accountBootstrap';
import { createSyncDomainEvent, encodeSyncDomainEvent } from './domainEvents';
import { encodeRecoveryKeyPackage, wrapAccountRootKeyForRecovery } from './e2eeKeyPackage';
import { encryptSyncPayload } from './encryptedSyncObject';
import { generateDeviceKeyPair } from './deviceKeys';
import {
  clearSyncSecrets,
  encodeSyncSecretBytes,
  loadSyncSecrets,
  savePendingPrimaryRecoverySecret,
  saveSyncSecrets,
  type SyncSecretStorage,
} from './syncSecrets';
import {
  buildPartitionManifest,
  encodePartitionManifestPayload,
  encodePartitionSnapshotPayload,
} from './syncPartitioning';
import { encodeRepositorySnapshotPayload } from './syncSnapshot';
import type { SupabaseControlPlaneClient } from './supabaseControlPlane';
import { createRepository } from './testSupport';

class MemorySecretStorage implements SyncSecretStorage {
  private readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async removeItem(key: string): Promise<void> { this.values.delete(key); }
}

class FailSecondSyncSecretWriteStorage extends MemorySecretStorage {
  private syncSecretWrites = 0;

  async setItem(key: string, value: string): Promise<void> {
    if (key === 'multi_device_sync_secrets_v1') {
      this.syncSecretWrites += 1;
      if (this.syncSecretWrites === 2) throw new Error('post-finalize secret write failure');
    }
    await super.setItem(key, value);
  }
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const googleSession: GoogleAccountSession = {
  userId: 'google-1',
  email: 'writer@example.com',
  displayName: 'Writer',
  accessToken: 'drive-token',
};

const supabaseSession = {
  accessToken: 'supabase-token',
  refreshToken: 'refresh',
  expiresAt: 2_000_000_000,
};

const recoveredSecurityConfig: SecurityConfig = {
  isPinCreated: true,
  pinHash: 'pin-hash',
  pinSalt: 'pin-salt',
  pinLength: 4,
  isBiometricsEnabled: false,
  isLocked: false,
  recoveryQuestionId: 'first-pet',
  recoveryAnswerHash: 'answer-hash',
  recoveryAnswerSalt: 'answer-salt',
  recoveryAnswerIterations: 310_000,
  linkedGoogleUserId: 'google-1',
  linkedGoogleEmail: 'writer@example.com',
  linkedGoogleBoundAt: 1,
};

const recoveredDriveBackupSettings: DriveBackupSettings = {
  linkedGoogleUserId: 'google-1',
  linkedGoogleEmail: 'writer@example.com',
  linkedGoogleDisplayName: 'Writer',
  linkedAt: 1,
  cloudWriteBlocked: false,
};

const createPartitionedPendingRecoveryFixture = async () => {
  const repository = await createRepository();
  const secretStorage = new MemorySecretStorage();
  const accountRootKey = crypto.getRandomValues(new Uint8Array(32));
  const deviceKeys = await generateDeviceKeyPair();
  const recoveryBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    accountRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1' },
  ));
  const snapshot = {
    diaries: [{
      id: 'diary-default',
      name: 'Diary',
      emoji: 'D',
      color: '#000',
      isLocked: false,
      entryCount: 0,
      lastUpdated: 'No entries yet',
    }],
    entries: [],
    notes: [],
    syncRecordVersions: {},
    syncMediaPointers: {},
  };
  const encryptedCore = await encryptSyncPayload(
    accountRootKey,
    'partition_snapshot',
    encodePartitionSnapshotPayload(snapshot, 'account-1', 'core', 4),
    { keyEpoch: 1 },
  );
  const manifest = buildPartitionManifest({
    accountId: 'account-1',
    keyEpoch: 1,
    snapshot,
    snapshotMetadata: {
      core: {
        latestSnapshotSequence: 4,
        latestSnapshotDriveFileId: 'drive-core',
        latestSnapshotSha256: encryptedCore.sha256,
        latestSnapshotSizeBytes: encryptedCore.bytes.byteLength,
        headSequence: 5,
      },
    },
    now: new Date('2026-07-08T00:00:00.000Z'),
  });
  const encryptedManifest = await encryptSyncPayload(
    accountRootKey,
    'manifest',
    encodePartitionManifestPayload(manifest),
    { keyEpoch: 1 },
  );
  const tailNote = {
    id: 'note-tail',
    title: 'Tail note',
    body: 'Caught up before finalize.',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const tailEvent = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'old-primary',
    recordType: 'note',
    operation: 'upsert',
    recordId: tailNote.id,
    baseRecordVersion: 0,
    payload: tailNote,
  });
  const encryptedTail = await encryptSyncPayload(
    accountRootKey,
    'event',
    encodeSyncDomainEvent(tailEvent),
    { keyEpoch: 1 },
  );
  const recoveryObject: SyncObjectMetadata = {
    id: 'recovery-object',
    accountId: 'account-1',
    sequence: 1,
    driveFileId: 'drive-recovery',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryBytes),
    sizeBytes: recoveryBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:00.000Z',
    keyEpoch: 1,
  };
  const coreObject: SyncObjectMetadata = {
    id: 'core-object',
    accountId: 'account-1',
    sequence: 4,
    driveFileId: 'drive-core',
    objectKind: 'partition_snapshot',
    sha256: encryptedCore.sha256,
    sizeBytes: encryptedCore.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:01.000Z',
    partitionKey: 'core',
    keyEpoch: 1,
  };
  const manifestObject: SyncObjectMetadata = {
    id: 'manifest-object',
    accountId: 'account-1',
    sequence: 5,
    driveFileId: 'drive-manifest',
    objectKind: 'manifest',
    sha256: encryptedManifest.sha256,
    sizeBytes: encryptedManifest.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:02.000Z',
    keyEpoch: 1,
  };
  const tailObject: SyncObjectMetadata = {
    id: 'tail-object',
    accountId: 'account-1',
    sequence: 6,
    driveFileId: 'drive-tail',
    objectKind: 'event',
    sha256: encryptedTail.sha256,
    sizeBytes: encryptedTail.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:03.000Z',
    recordType: 'note',
    recordId: tailNote.id,
    baseRecordVersion: 0,
    recordVersion: 1,
    partitionKey: 'month:1970-01',
    keyEpoch: 1,
  };
  const account: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '',
    activePrimaryDeviceId: 'old-primary',
    currentSyncSequence: 6,
    currentSnapshotSequence: 5,
    currentKeyEpoch: 1,
    recoveryConfigured: true,
  };
  const device: SyncDevice = {
    id: 'new-primary',
    accountId: 'account-1',
    role: 'primary_mobile',
    publicKey: deviceKeys.publicKey,
    displayName: 'Phone',
    platform: 'android',
    createdAt: '',
    lastSeenAt: '',
    revokedAt: null,
    replacedByDeviceId: null,
    activationState: 'pending_recovery',
  };
  const attempt: PrimaryRecoveryAttempt = {
    id: 'attempt-1',
    accountId: 'account-1',
    deviceId: 'new-primary',
    previousPrimaryDeviceId: 'old-primary',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    displayName: 'Phone',
    platform: 'android',
    status: 'pending',
    startedAt: '',
    finalizedAt: null,
    restoredSequence: null,
  };
  const pending: PendingPrimaryRecovery = {
    version: 1,
    phase: 'registered',
    account,
    device,
    attempt,
    devicePrivateKeyJwk: deviceKeys.privateKeyJwk,
    accountRootKeyBase64: encodeSyncSecretBytes(accountRootKey),
    accountRootKeysBase64: { 1: encodeSyncSecretBytes(accountRootKey) },
    recoveryKeyDriveFileId: recoveryObject.driveFileId,
    recoveryKeyEpoch: 1,
    recoveryKeySequence: recoveryObject.sequence,
    currentSyncSequence: 0,
    securityConfig: recoveredSecurityConfig,
    driveBackupSettings: recoveredDriveBackupSettings,
    googleSession,
    supabaseSession,
    startedAt: 1,
    updatedAt: 1,
  };
  const files = new Map<string, Uint8Array>([
    ['drive-recovery', recoveryBytes],
    ['drive-manifest', encryptedManifest.bytes],
    ['drive-core', encryptedCore.bytes],
    ['drive-tail', encryptedTail.bytes],
  ]);
  const callOrder: string[] = [];
  const finalizeSequences: number[] = [];
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => account,
    listAccountRecoveryObjects: async () => [recoveryObject],
    beginPrimaryMobileRecovery: async () => {
      throw new Error('begin should not be called while resuming a pending recovery');
    },
    getLatestRestoreManifest: async () => ({
      manifestObject,
      coreSnapshotObject: coreObject,
      currentSyncSequence: 5,
      keyEpoch: 1,
    }),
    getPartitionRestoreBundle: async (_deviceId: string, partitionKeys: string[]) => {
      assert.deepEqual(partitionKeys, ['core']);
      return [{ partitionKey: 'core', snapshotObject: coreObject, tailObjects: [] }];
    },
    updateDeviceCursor: async (input: { lastAppliedSequence: number }) => {
      callOrder.push(`cursor:${input.lastAppliedSequence}`);
      return {};
    },
    listSyncObjectsAfter: async (_deviceId: string, afterSequence: number) => (
      afterSequence < tailObject.sequence ? [tailObject] : []
    ),
    finalizePrimaryMobileRecovery: async (input: { restoredSequence: number }) => {
      callOrder.push(`finalize:${input.restoredSequence}`);
      finalizeSequences.push(input.restoredSequence);
      if (finalizeSequences.length === 1) throw new Error('stale_recovery_sequence');
      account.activePrimaryDeviceId = device.id;
      return {};
    },
    abortPrimaryMobileRecovery: async () => {
      throw new Error('abort should not be called');
    },
  } as unknown as SupabaseControlPlaneClient;

  return {
    repository,
    secretStorage,
    accountRootKey,
    pending,
    tailNote,
    files,
    callOrder,
    finalizeSequences,
    controlPlane,
  };
};

test('primary recovery aborts without finalizing when restore fails', async () => {
  const repository = await createRepository();
  const originalRootKey = crypto.getRandomValues(new Uint8Array(32));
  await repository.createNote({
    title: 'Original local note',
    body: 'Do not replace me.',
    isPinned: false,
    tags: [],
  });
  await repository.saveSecurityConfig({
    isPinCreated: true,
    pinHash: 'old-pin-hash',
    pinSalt: 'old-pin-salt',
    pinLength: 4,
    isBiometricsEnabled: false,
    isLocked: false,
    linkedGoogleUserId: 'old-google',
    linkedGoogleEmail: 'old@example.com',
    linkedGoogleBoundAt: 1,
  });
  await repository.saveDriveBackupSettings({
    ...(await repository.getDriveBackupSettings()),
    linkedGoogleUserId: 'old-google',
    linkedGoogleEmail: 'old@example.com',
    linkedGoogleDisplayName: 'Old Writer',
    linkedAt: 1,
    cloudWriteBlocked: true,
  });
  await repository.saveLocalSyncAccountState({
    accountId: 'local-account',
    deviceId: 'local-device',
    deviceRole: 'primary_mobile',
    googleUserId: 'old-google',
    googleEmail: 'old@example.com',
    devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'local-key',
    latestSnapshotDriveFileId: 'local-snapshot',
    currentSyncSequence: 4,
    keyEpoch: 1,
    linkedAt: 1,
  });
  await saveSyncSecrets({
    version: 1,
    accountId: 'local-account',
    accountRootKey: originalRootKey,
    accountRootKeys: { 1: originalRootKey },
    devicePrivateKeyJwk: '{}',
    supabaseSession: { accessToken: 'old-supabase-token', refreshToken: 'old-refresh', expiresAt: 2_000_000_000 },
    googleSession: { userId: 'old-google', email: 'old@example.com', displayName: 'Old Writer', accessToken: 'old-drive-token' },
  });
  const accountRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    accountRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1' },
  ));
  const badManifestBytes = new TextEncoder().encode('not an encrypted manifest');
  const recoveryObject: SyncObjectMetadata = {
    id: 'recovery-object',
    accountId: 'account-1',
    sequence: 1,
    driveFileId: 'drive-recovery',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryBytes),
    sizeBytes: recoveryBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:00.000Z',
    keyEpoch: 1,
  };
  const manifestObject: SyncObjectMetadata = {
    id: 'manifest-object',
    accountId: 'account-1',
    sequence: 10,
    driveFileId: 'drive-bad-manifest',
    objectKind: 'manifest',
    sha256: await sha256Hex(badManifestBytes),
    sizeBytes: badManifestBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:01.000Z',
    keyEpoch: 1,
  };
  const existingAccount: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '',
    activePrimaryDeviceId: 'old-primary',
    currentSyncSequence: 10,
    currentSnapshotSequence: 8,
    currentKeyEpoch: 1,
    recoveryConfigured: true,
  };
  let abortCalls = 0;
  let finalizeCalls = 0;
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => existingAccount,
    listAccountRecoveryObjects: async () => [recoveryObject],
    beginPrimaryMobileRecovery: async () => ({
      account: existingAccount,
      device: {
        id: 'new-primary',
        accountId: 'account-1',
        role: 'primary_mobile',
        publicKey: '{}',
        displayName: 'Phone',
        platform: 'android',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
        replacedByDeviceId: null,
        activationState: 'pending_recovery',
      },
      attempt: {
        id: 'attempt-1',
        accountId: 'account-1',
        deviceId: 'new-primary',
        previousPrimaryDeviceId: 'old-primary',
        googleUserId: 'google-1',
        googleEmail: 'writer@example.com',
        displayName: 'Phone',
        platform: 'android',
        status: 'pending',
        startedAt: '',
        finalizedAt: null,
        restoredSequence: null,
      },
    }),
    getLatestRestoreManifest: async () => ({
      manifestObject,
      coreSnapshotObject: null,
      currentSyncSequence: 10,
      keyEpoch: 1,
    }),
    finalizePrimaryMobileRecovery: async () => {
      finalizeCalls += 1;
      throw new Error('finalize should not be called');
    },
    abortPrimaryMobileRecovery: async () => {
      abortCalls += 1;
      return {
        id: 'attempt-1',
        accountId: 'account-1',
        deviceId: 'new-primary',
        previousPrimaryDeviceId: 'old-primary',
        googleUserId: 'google-1',
        googleEmail: 'writer@example.com',
        displayName: 'Phone',
        platform: 'android',
        status: 'aborted',
        startedAt: '',
        finalizedAt: null,
        restoredSequence: null,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-recovery', recoveryBytes],
    ['drive-bad-manifest', badManifestBytes],
  ]);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

  try {
    await assert.rejects(
      () => bootstrapNewMobileAccount({
        googleSession: {
          userId: 'google-1',
          email: 'writer@example.com',
          displayName: 'Writer',
          accessToken: 'drive-token',
        },
        supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
        recoveryPassphrase: 'a sufficiently long passphrase',
        localPin: '1234',
        recoveryQuestion: { questionId: 'first-pet', answer: 'Answer' },
        repository,
        controlPlane,
        displayName: 'Phone',
        platform: 'android',
        download: async (_session, fileId) => files.get(fileId)!,
      }),
      /authentication failed|manifest|invalid|checksum|unexpected token|json/i,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings[0] || '', /Partitioned primary recovery restore failed/);
  assert.equal(finalizeCalls, 0);
  assert.equal(abortCalls, 1);
  assert.equal((await repository.listNotes())[0]?.title, 'Original local note');
  assert.equal((await repository.getSecurityConfig()).linkedGoogleUserId, 'old-google');
  assert.equal((await repository.getDriveBackupSettings()).linkedGoogleEmail, 'old@example.com');
  assert.equal((await repository.getLocalSyncAccountState())?.accountId, 'local-account');
  assert.deepEqual((await loadSyncSecrets())?.accountRootKey, originalRootKey);
  await clearSyncSecrets();
});

test('primary recovery falls back to legacy snapshot when partitioned manifest restore fails', async () => {
  const repository = await createRepository();
  const accountRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    accountRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1' },
  ));
  const snapshot = {
    diaries: [{
      id: 'diary-default',
      name: 'Diary',
      emoji: 'D',
      color: '#000',
      isLocked: false,
      entryCount: 0,
      lastUpdated: 'No entries yet',
    }],
    entries: [],
    notes: [{
      id: 'note-legacy',
      title: 'Legacy note',
      body: 'Restored after manifest failure.',
      isPinned: false,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    }],
    syncRecordVersions: {},
    syncMediaPointers: {},
  };
  const encryptedSnapshot = await encryptSyncPayload(
    accountRootKey,
    'snapshot',
    encodeRepositorySnapshotPayload(snapshot, 'account-1', 7),
    { keyEpoch: 1 },
  );
  const badManifestBytes = new TextEncoder().encode('not an encrypted manifest');
  const recoveryObject: SyncObjectMetadata = {
    id: 'recovery-object',
    accountId: 'account-1',
    sequence: 1,
    driveFileId: 'drive-recovery',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryBytes),
    sizeBytes: recoveryBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:00.000Z',
    keyEpoch: 1,
  };
  const snapshotObject: SyncObjectMetadata = {
    id: 'snapshot-object',
    accountId: 'account-1',
    sequence: 8,
    driveFileId: 'drive-snapshot',
    objectKind: 'snapshot',
    sha256: encryptedSnapshot.sha256,
    sizeBytes: encryptedSnapshot.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:01.000Z',
    keyEpoch: 1,
  };
  const manifestObject: SyncObjectMetadata = {
    id: 'manifest-object',
    accountId: 'account-1',
    sequence: 10,
    driveFileId: 'drive-bad-manifest',
    objectKind: 'manifest',
    sha256: await sha256Hex(badManifestBytes),
    sizeBytes: badManifestBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:02.000Z',
    keyEpoch: 1,
  };
  const existingAccount: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '',
    activePrimaryDeviceId: 'old-primary',
    currentSyncSequence: 10,
    currentSnapshotSequence: 8,
    currentKeyEpoch: 1,
    recoveryConfigured: true,
  };
  const finalizeSequences: number[] = [];
  let abortCalls = 0;
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => existingAccount,
    listAccountRecoveryObjects: async () => [recoveryObject, snapshotObject],
    beginPrimaryMobileRecovery: async (input: { publicKey: string }) => ({
      account: existingAccount,
      device: {
        id: 'new-primary',
        accountId: 'account-1',
        role: 'primary_mobile',
        publicKey: input.publicKey,
        displayName: 'Phone',
        platform: 'android',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
        replacedByDeviceId: null,
        activationState: 'pending_recovery',
      },
      attempt: {
        id: 'attempt-1',
        accountId: 'account-1',
        deviceId: 'new-primary',
        previousPrimaryDeviceId: 'old-primary',
        googleUserId: 'google-1',
        googleEmail: 'writer@example.com',
        displayName: 'Phone',
        platform: 'android',
        status: 'pending',
        startedAt: '',
        finalizedAt: null,
        restoredSequence: null,
      },
    }),
    getLatestRestoreManifest: async () => ({
      manifestObject,
      coreSnapshotObject: null,
      currentSyncSequence: 10,
      keyEpoch: 1,
    }),
    updateDeviceCursor: async () => ({}),
    listSyncObjectsAfter: async () => [],
    finalizePrimaryMobileRecovery: async (input: { restoredSequence: number }) => {
      finalizeSequences.push(input.restoredSequence);
      existingAccount.activePrimaryDeviceId = 'new-primary';
      return {};
    },
    abortPrimaryMobileRecovery: async () => {
      abortCalls += 1;
      throw new Error('abort should not be called');
    },
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-recovery', recoveryBytes],
    ['drive-snapshot', encryptedSnapshot.bytes],
    ['drive-bad-manifest', badManifestBytes],
  ]);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

  try {
    const result = await bootstrapNewMobileAccount({
      googleSession,
      supabaseSession,
      recoveryPassphrase: 'a sufficiently long passphrase',
      localPin: '1234',
      recoveryQuestion: { questionId: 'first-pet', answer: 'Answer' },
      repository,
      controlPlane,
      displayName: 'Phone',
      platform: 'android',
      download: async (_session, fileId) => files.get(fileId)!,
    });

    assert.equal(result.mode, 'recovered');
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings[0] || '', /Partitioned primary recovery restore failed/);
  assert.deepEqual(finalizeSequences, [8]);
  assert.equal(abortCalls, 0);
  assert.equal((await repository.getNote('note-legacy'))?.title, 'Legacy note');
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 8);
});

test('primary recovery finalizes after partition restore and stale tail replay', async () => {
  const repository = await createRepository();
  const accountRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    accountRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1' },
  ));
  const snapshot = {
    diaries: [{
      id: 'diary-default',
      name: 'Diary',
      emoji: 'D',
      color: '#000',
      isLocked: false,
      entryCount: 0,
      lastUpdated: 'No entries yet',
    }],
    entries: [],
    notes: [],
    syncRecordVersions: {},
    syncMediaPointers: {},
  };
  const encryptedCore = await encryptSyncPayload(
    accountRootKey,
    'partition_snapshot',
    encodePartitionSnapshotPayload(snapshot, 'account-1', 'core', 4),
    { keyEpoch: 1 },
  );
  const manifest = buildPartitionManifest({
    accountId: 'account-1',
    keyEpoch: 1,
    snapshot,
    snapshotMetadata: {
      core: {
        latestSnapshotSequence: 4,
        latestSnapshotDriveFileId: 'drive-core',
        latestSnapshotSha256: encryptedCore.sha256,
        latestSnapshotSizeBytes: encryptedCore.bytes.byteLength,
        headSequence: 5,
      },
    },
    now: new Date('2026-07-08T00:00:00.000Z'),
  });
  const encryptedManifest = await encryptSyncPayload(
    accountRootKey,
    'manifest',
    encodePartitionManifestPayload(manifest),
    { keyEpoch: 1 },
  );
  const tailNote = {
    id: 'note-tail',
    title: 'Tail note',
    body: 'Caught up before finalize.',
    isPinned: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const tailEvent = createSyncDomainEvent({
    accountId: 'account-1',
    deviceId: 'old-primary',
    recordType: 'note',
    operation: 'upsert',
    recordId: tailNote.id,
    baseRecordVersion: 0,
    payload: tailNote,
  });
  const encryptedTail = await encryptSyncPayload(
    accountRootKey,
    'event',
    encodeSyncDomainEvent(tailEvent),
    { keyEpoch: 1 },
  );
  const recoveryObject: SyncObjectMetadata = {
    id: 'recovery-object',
    accountId: 'account-1',
    sequence: 1,
    driveFileId: 'drive-recovery',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryBytes),
    sizeBytes: recoveryBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:00.000Z',
    keyEpoch: 1,
  };
  const coreObject: SyncObjectMetadata = {
    id: 'core-object',
    accountId: 'account-1',
    sequence: 4,
    driveFileId: 'drive-core',
    objectKind: 'partition_snapshot',
    sha256: encryptedCore.sha256,
    sizeBytes: encryptedCore.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:01.000Z',
    partitionKey: 'core',
    keyEpoch: 1,
  };
  const manifestObject: SyncObjectMetadata = {
    id: 'manifest-object',
    accountId: 'account-1',
    sequence: 5,
    driveFileId: 'drive-manifest',
    objectKind: 'manifest',
    sha256: encryptedManifest.sha256,
    sizeBytes: encryptedManifest.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:02.000Z',
    keyEpoch: 1,
  };
  const tailObject: SyncObjectMetadata = {
    id: 'tail-object',
    accountId: 'account-1',
    sequence: 6,
    driveFileId: 'drive-tail',
    objectKind: 'event',
    sha256: encryptedTail.sha256,
    sizeBytes: encryptedTail.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:03.000Z',
    recordType: 'note',
    recordId: tailNote.id,
    baseRecordVersion: 0,
    recordVersion: 1,
    partitionKey: 'month:1970-01',
    keyEpoch: 1,
  };
  const existingAccount: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '',
    activePrimaryDeviceId: 'old-primary',
    currentSyncSequence: 6,
    currentSnapshotSequence: 5,
    currentKeyEpoch: 1,
    recoveryConfigured: true,
  };
  const callOrder: string[] = [];
  const finalizeSequences: number[] = [];
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => existingAccount,
    listAccountRecoveryObjects: async () => [recoveryObject],
    beginPrimaryMobileRecovery: async () => ({
      account: existingAccount,
      device: {
        id: 'new-primary',
        accountId: 'account-1',
        role: 'primary_mobile',
        publicKey: '{}',
        displayName: 'Phone',
        platform: 'android',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
        replacedByDeviceId: null,
        activationState: 'pending_recovery',
      },
      attempt: {
        id: 'attempt-1',
        accountId: 'account-1',
        deviceId: 'new-primary',
        previousPrimaryDeviceId: 'old-primary',
        googleUserId: 'google-1',
        googleEmail: 'writer@example.com',
        displayName: 'Phone',
        platform: 'android',
        status: 'pending',
        startedAt: '',
        finalizedAt: null,
        restoredSequence: null,
      },
    }),
    getLatestRestoreManifest: async () => ({
      manifestObject,
      coreSnapshotObject: coreObject,
      currentSyncSequence: 5,
      keyEpoch: 1,
    }),
    getPartitionRestoreBundle: async (_deviceId: string, partitionKeys: string[]) => {
      assert.deepEqual(partitionKeys, ['core']);
      return [{
        partitionKey: 'core',
        snapshotObject: coreObject,
        tailObjects: [],
      }];
    },
    updateDeviceCursor: async (input: { lastAppliedSequence: number }) => {
      callOrder.push(`cursor:${input.lastAppliedSequence}`);
      return {};
    },
    listSyncObjectsAfter: async (_deviceId: string, afterSequence: number) => (
      afterSequence < tailObject.sequence ? [tailObject] : []
    ),
    finalizePrimaryMobileRecovery: async (input: { restoredSequence: number }) => {
      callOrder.push(`finalize:${input.restoredSequence}`);
      finalizeSequences.push(input.restoredSequence);
      if (finalizeSequences.length === 1) throw new Error('stale_recovery_sequence');
      return {};
    },
    abortPrimaryMobileRecovery: async () => {
      throw new Error('abort should not be called');
    },
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-recovery', recoveryBytes],
    ['drive-manifest', encryptedManifest.bytes],
    ['drive-core', encryptedCore.bytes],
    ['drive-tail', encryptedTail.bytes],
  ]);

  const result = await bootstrapNewMobileAccount({
    googleSession: {
      userId: 'google-1',
      email: 'writer@example.com',
      displayName: 'Writer',
      accessToken: 'drive-token',
    },
    supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    recoveryPassphrase: 'a sufficiently long passphrase',
    localPin: '1234',
    recoveryQuestion: { questionId: 'first-pet', answer: 'Answer' },
    repository,
    controlPlane,
    displayName: 'Phone',
    platform: 'android',
    download: async (_session, fileId) => files.get(fileId)!,
  });

  assert.equal(result.mode, 'recovered');
  assert.deepEqual(finalizeSequences, [5, 6]);
  assert.deepEqual(callOrder, ['cursor:5', 'finalize:5', 'cursor:6', 'finalize:6']);
  assert.equal((await repository.getNote(tailNote.id))?.title, 'Tail note');
  assert.equal((await repository.getLocalSyncAccountState())?.currentSyncSequence, 6);
});

test('primary recovery restores partition snapshots encrypted with older key epochs', async () => {
  const repository = await createRepository();
  const secretStorage = new MemorySecretStorage();
  const epochOneRootKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryOneBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    epochOneRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1', keyEpoch: 1, keyVersion: 1 },
  ));
  const recoveryTwoBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    epochTwoRootKey,
    'a sufficiently long passphrase',
    { accountId: 'account-1', keyEpoch: 2, keyVersion: 2 },
  ));
  const snapshot = {
    diaries: [{
      id: 'diary-default',
      name: 'Diary',
      emoji: 'D',
      color: '#000',
      isLocked: false,
      entryCount: 0,
      lastUpdated: 'No entries yet',
    }],
    entries: [],
    notes: [],
    syncRecordVersions: {},
    syncMediaPointers: {},
  };
  const encryptedCore = await encryptSyncPayload(
    epochOneRootKey,
    'partition_snapshot',
    encodePartitionSnapshotPayload(snapshot, 'account-1', 'core', 4),
    { keyEpoch: 1 },
  );
  const manifest = buildPartitionManifest({
    accountId: 'account-1',
    keyEpoch: 2,
    snapshot,
    snapshotMetadata: {
      core: {
        latestSnapshotSequence: 4,
        latestSnapshotDriveFileId: 'drive-core',
        latestSnapshotSha256: encryptedCore.sha256,
        latestSnapshotSizeBytes: encryptedCore.bytes.byteLength,
        headSequence: 5,
      },
    },
    now: new Date('2026-07-08T00:00:00.000Z'),
  });
  const encryptedManifest = await encryptSyncPayload(
    epochTwoRootKey,
    'manifest',
    encodePartitionManifestPayload(manifest),
    { keyEpoch: 2 },
  );
  const recoveryOneObject: SyncObjectMetadata = {
    id: 'recovery-object-1',
    accountId: 'account-1',
    sequence: 1,
    driveFileId: 'drive-recovery-1',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryOneBytes),
    sizeBytes: recoveryOneBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:00.000Z',
    keyEpoch: 1,
  };
  const recoveryTwoObject: SyncObjectMetadata = {
    id: 'recovery-object-2',
    accountId: 'account-1',
    sequence: 2,
    driveFileId: 'drive-recovery-2',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryTwoBytes),
    sizeBytes: recoveryTwoBytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:01.000Z',
    keyEpoch: 2,
  };
  const coreObject: SyncObjectMetadata = {
    id: 'core-object',
    accountId: 'account-1',
    sequence: 4,
    driveFileId: 'drive-core',
    objectKind: 'partition_snapshot',
    sha256: encryptedCore.sha256,
    sizeBytes: encryptedCore.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:02.000Z',
    partitionKey: 'core',
    keyEpoch: 1,
  };
  const manifestObject: SyncObjectMetadata = {
    id: 'manifest-object',
    accountId: 'account-1',
    sequence: 5,
    driveFileId: 'drive-manifest',
    objectKind: 'manifest',
    sha256: encryptedManifest.sha256,
    sizeBytes: encryptedManifest.bytes.byteLength,
    createdByDeviceId: 'old-primary',
    createdAt: '2026-07-08T00:00:03.000Z',
    keyEpoch: 2,
  };
  const existingAccount: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '',
    activePrimaryDeviceId: 'old-primary',
    currentSyncSequence: 5,
    currentSnapshotSequence: 4,
    currentKeyEpoch: 2,
    recoveryConfigured: true,
  };
  const finalizeSequences: number[] = [];
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => existingAccount,
    listAccountRecoveryObjects: async () => [recoveryOneObject, recoveryTwoObject],
    beginPrimaryMobileRecovery: async (input: { publicKey: string }) => ({
      account: existingAccount,
      device: {
        id: 'new-primary',
        accountId: 'account-1',
        role: 'primary_mobile',
        publicKey: input.publicKey,
        displayName: 'Phone',
        platform: 'android',
        createdAt: '',
        lastSeenAt: '',
        revokedAt: null,
        replacedByDeviceId: null,
        activationState: 'pending_recovery',
      },
      attempt: {
        id: 'attempt-1',
        accountId: 'account-1',
        deviceId: 'new-primary',
        previousPrimaryDeviceId: 'old-primary',
        googleUserId: 'google-1',
        googleEmail: 'writer@example.com',
        displayName: 'Phone',
        platform: 'android',
        status: 'pending',
        startedAt: '',
        finalizedAt: null,
        restoredSequence: null,
      },
    }),
    getLatestRestoreManifest: async () => ({
      manifestObject,
      coreSnapshotObject: coreObject,
      currentSyncSequence: 5,
      keyEpoch: 2,
    }),
    getPartitionRestoreBundle: async (_deviceId: string, partitionKeys: string[]) => {
      assert.deepEqual(partitionKeys, ['core']);
      return [{ partitionKey: 'core', snapshotObject: coreObject, tailObjects: [] }];
    },
    updateDeviceCursor: async () => ({}),
    listSyncObjectsAfter: async () => [],
    finalizePrimaryMobileRecovery: async (input: { restoredSequence: number }) => {
      finalizeSequences.push(input.restoredSequence);
      return {};
    },
    abortPrimaryMobileRecovery: async () => {
      throw new Error('abort should not be called');
    },
  } as unknown as SupabaseControlPlaneClient;
  const files = new Map<string, Uint8Array>([
    ['drive-recovery-1', recoveryOneBytes],
    ['drive-recovery-2', recoveryTwoBytes],
    ['drive-manifest', encryptedManifest.bytes],
    ['drive-core', encryptedCore.bytes],
  ]);

  const result = await bootstrapNewMobileAccount({
    googleSession,
    supabaseSession,
    recoveryPassphrase: 'a sufficiently long passphrase',
    localPin: '1234',
    recoveryQuestion: { questionId: 'first-pet', answer: 'Answer' },
    repository,
    controlPlane,
    displayName: 'Phone',
    platform: 'android',
    download: async (_session, fileId) => files.get(fileId)!,
    secretStorage,
  });

  const secrets = await loadSyncSecrets(secretStorage);
  assert.equal(result.mode, 'recovered');
  assert.deepEqual(finalizeSequences, [5]);
  assert.equal((await repository.listDiaries())[0]?.name, 'Diary');
  assert.equal((await repository.getLocalSyncAccountState())?.keyEpoch, 2);
  assert.deepEqual(secrets?.accountRootKey, epochTwoRootKey);
  assert.deepEqual(secrets?.accountRootKeys?.[1], epochOneRootKey);
  assert.deepEqual(secrets?.accountRootKeys?.[2], epochTwoRootKey);
});

test('primary recovery keeps its journal when final cleanup fails after server finalize', async () => {
  const fixture = await createPartitionedPendingRecoveryFixture();
  const secretStorage = new FailSecondSyncSecretWriteStorage();
  let abortCalls = 0;
  await fixture.repository.createNote({
    title: 'Original local note',
    body: 'Rollback would restore this note.',
    isPinned: false,
    tags: [],
  });
  const controlPlane = {
    ...(fixture.controlPlane as unknown as Record<string, unknown>),
    beginPrimaryMobileRecovery: async () => ({
      account: fixture.pending.account,
      device: fixture.pending.device,
      attempt: fixture.pending.attempt,
    }),
    abortPrimaryMobileRecovery: async () => {
      abortCalls += 1;
      throw new Error('abort should not be called after finalize');
    },
  } as unknown as SupabaseControlPlaneClient;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

  try {
    await assert.rejects(
      () => bootstrapNewMobileAccount({
        googleSession,
        supabaseSession,
        recoveryPassphrase: 'a sufficiently long passphrase',
        localPin: '1234',
        recoveryQuestion: { questionId: 'first-pet', answer: 'Answer' },
        repository: fixture.repository,
        controlPlane,
        displayName: 'Phone',
        platform: 'android',
        download: async (_session, fileId) => fixture.files.get(fileId)!,
        secretStorage,
      }),
      /post-finalize secret write failure/,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.match(warnings[0] || '', /Primary recovery finalized remotely/);
  assert.equal(abortCalls, 0);
  assert.equal(fixture.pending.account.activePrimaryDeviceId, fixture.pending.device.id);
  assert.deepEqual(fixture.finalizeSequences, [5, 6]);
  assert.equal((await fixture.repository.getNote(fixture.tailNote.id))?.title, 'Tail note');
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.deviceId, fixture.pending.device.id);
  assert.equal((await loadSyncSecrets(secretStorage))?.accountId, fixture.pending.account.id);
  assert.equal((await loadPendingPrimaryRecovery(secretStorage))?.phase, 'server_finalized');
});

test('primary recovery resumes a registered pending attempt without the passphrase', async () => {
  const fixture = await createPartitionedPendingRecoveryFixture();
  await savePendingPrimaryRecoverySecret(fixture.pending, fixture.secretStorage);

  const result = await bootstrapNewMobileAccount({
    googleSession,
    supabaseSession,
    recoveryPassphrase: 'not the original recovery passphrase',
    localPin: '9999',
    recoveryQuestion: { questionId: 'unused', answer: 'unused' },
    repository: fixture.repository,
    controlPlane: fixture.controlPlane,
    displayName: 'Phone',
    platform: 'android',
    download: async (_session, fileId) => fixture.files.get(fileId)!,
    secretStorage: fixture.secretStorage,
  });

  assert.equal(result.mode, 'recovered');
  assert.deepEqual(fixture.finalizeSequences, [5, 6]);
  assert.deepEqual(fixture.callOrder, ['cursor:5', 'finalize:5', 'cursor:6', 'finalize:6']);
  assert.equal((await fixture.repository.getNote(fixture.tailNote.id))?.title, 'Tail note');
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.currentSyncSequence, 6);
  assert.equal((await fixture.repository.getSecurityConfig()).linkedGoogleUserId, 'google-1');
  assert.deepEqual((await loadSyncSecrets(fixture.secretStorage))?.accountRootKey, fixture.accountRootKey);
  assert.equal(await loadPendingPrimaryRecovery(fixture.secretStorage), null);
});

test('primary recovery resume clears the journal when server finalize already succeeded', async () => {
  const fixture = await createPartitionedPendingRecoveryFixture();
  const pending: PendingPrimaryRecovery = {
    ...fixture.pending,
    phase: 'cursor_updated',
    currentSyncSequence: 6,
  };
  await fixture.repository.saveLocalSyncAccountState({
    accountId: pending.account.id,
    deviceId: pending.device.id,
    deviceRole: 'primary_mobile',
    googleUserId: googleSession.userId,
    googleEmail: googleSession.email!,
    devicePublicKey: pending.device.publicKey,
    recoveryKeyDriveFileId: pending.recoveryKeyDriveFileId,
    latestSnapshotDriveFileId: '',
    currentSyncSequence: 6,
    keyEpoch: 1,
    linkedAt: 1,
  });
  await saveSyncSecrets({
    version: 1,
    accountId: pending.account.id,
    accountRootKey: fixture.accountRootKey,
    accountRootKeys: { 1: fixture.accountRootKey },
    devicePrivateKeyJwk: pending.devicePrivateKeyJwk,
    supabaseSession,
    googleSession,
  }, fixture.secretStorage);
  await savePendingPrimaryRecoverySecret(pending, fixture.secretStorage);
  const controlPlane = {
    lookupCurrentGoogleAccount: async () => ({
      ...pending.account,
      activePrimaryDeviceId: pending.device.id,
      currentSyncSequence: 6,
    }),
    finalizePrimaryMobileRecovery: async () => {
      throw new Error('recovery_attempt_not_pending');
    },
    updateDeviceCursor: async () => {
      throw new Error('cursor should not be updated again');
    },
  } as unknown as SupabaseControlPlaneClient;

  const result = await resumePendingPrimaryRecovery({
    repository: fixture.repository,
    controlPlane,
    googleSession,
    secretStorage: fixture.secretStorage,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.primaryDeviceId, pending.device.id);
  assert.deepEqual((await loadSyncSecrets(fixture.secretStorage))?.accountRootKey, fixture.accountRootKey);
  assert.equal(await loadPendingPrimaryRecovery(fixture.secretStorage), null);
});
