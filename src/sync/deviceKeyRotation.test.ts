import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  GoogleAccountSession,
  KeyEpochRotation,
  LocalSyncAccountState,
  SyncAccount,
  SyncDevice,
  SyncDeviceCursor,
  SyncObjectMetadata,
} from '../types';
import { createRepository } from './testSupport';
import type { DriveSyncObjectSummary, UploadDriveSyncObjectInput } from './driveSyncObjects';
import { generateDeviceKeyPair } from './deviceKeys';
import {
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';
import {
  type DeviceKeyRotationControlPlane,
  type PendingDeviceKeyRotation,
  loadPendingDeviceKeyRotation,
  resumePendingDeviceKeyRotation,
  revokeDeviceWithKeyRotation,
} from './deviceKeyRotation';
import {
  encodeSyncSecretBytes,
  loadSyncSecrets,
  savePendingDeviceKeyRotationSecret,
  saveSyncSecrets,
  type SyncSecretStorage,
} from './syncSecrets';

class MemorySecretStorage implements SyncSecretStorage {
  private readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async removeItem(key: string): Promise<void> { this.values.delete(key); }
}

const googleSession: GoogleAccountSession = {
  userId: 'google-1',
  email: 'writer@example.com',
  displayName: 'Writer',
  accessToken: 'drive-token',
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

const createDevice = async (
  id: string,
  role: SyncDevice['role'],
  displayName: string,
): Promise<SyncDevice & { privateKeyJwk: string }> => {
  const keys = await generateDeviceKeyPair();
  return {
    id,
    accountId: 'account-1',
    role,
    publicKey: keys.publicKey,
    privateKeyJwk: keys.privateKeyJwk,
    displayName,
    platform: role === 'primary_mobile' ? 'android' : 'web',
    createdAt: '2026-07-08T00:00:00.000Z',
    lastSeenAt: '2026-07-08T00:00:00.000Z',
    revokedAt: null,
    replacedByDeviceId: null,
    activationState: 'active',
  };
};

const createState = (primary: SyncDevice): LocalSyncAccountState => ({
  accountId: 'account-1',
  deviceId: primary.id,
  deviceRole: 'primary_mobile',
  googleUserId: 'google-1',
  googleEmail: 'writer@example.com',
  devicePublicKey: primary.publicKey,
  recoveryKeyDriveFileId: 'drive-recovery-0',
  latestSnapshotDriveFileId: 'drive-snapshot-1',
  currentSyncSequence: 10,
  keyEpoch: 1,
  linkedAt: 1,
});

class FakeControlPlane implements DeviceKeyRotationControlPlane {
  account: SyncAccount = {
    id: 'account-1',
    googleUserId: 'google-1',
    googleEmail: 'writer@example.com',
    createdAt: '2026-07-08T00:00:00.000Z',
    activePrimaryDeviceId: 'primary-1',
    currentSyncSequence: 10,
    currentSnapshotSequence: 10,
    currentKeyEpoch: 1,
    partitionedSyncEnabled: false,
    recoveryConfigured: true,
  };

  devices: SyncDevice[] = [];
  objects: SyncObjectMetadata[] = [];
  recoveryObjects: SyncObjectMetadata[] = [];
  rotation: KeyEpochRotation | null = null;
  cursorUpdates: number[] = [];
  finalizeCalls = 0;
  lookupEpochs: number[] = [];
  failFinalizeOnceWith = '';

  async lookupCurrentGoogleAccount(): Promise<SyncAccount | null> {
    const queuedEpoch = this.lookupEpochs.shift();
    if (queuedEpoch !== undefined) return { ...this.account, currentKeyEpoch: queuedEpoch };
    return { ...this.account };
  }

  async listAccountDevices(): Promise<SyncDevice[]> {
    return this.devices.map(device => ({ ...device }));
  }

  async listAccountRecoveryObjects(): Promise<SyncObjectMetadata[]> {
    return [...this.recoveryObjects];
  }

  async listSyncObjectsAfter(_deviceId: string, afterSequence: number, limit = 100): Promise<SyncObjectMetadata[]> {
    return this.objects
      .filter(object => object.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }

  async beginDeviceKeyRotation(input: { primaryDeviceId: string; deviceId: string; reason: string }): Promise<KeyEpochRotation> {
    if (this.rotation?.status === 'pending') throw new Error('duplicate key violates unique pending rotation');
    this.rotation = {
      id: 'rotation-1',
      accountId: 'account-1',
      primaryDeviceId: input.primaryDeviceId,
      revokedDeviceId: input.deviceId,
      reason: input.reason,
      nextKeyEpoch: (this.account.currentKeyEpoch || 1) + 1,
      startingSequence: this.account.currentSyncSequence,
      keyPackageSequence: null,
      status: 'pending',
      createdAt: '2026-07-08T00:00:01.000Z',
      finalizedAt: null,
    };
    return { ...this.rotation };
  }

  async abortDeviceKeyRotation(_primaryDeviceId: string, rotationId: string): Promise<KeyEpochRotation> {
    if (!this.rotation || this.rotation.id !== rotationId || this.rotation.status !== 'pending') {
      throw new Error('key_rotation_not_found');
    }
    this.rotation = { ...this.rotation, status: 'aborted' };
    return { ...this.rotation };
  }

  async commitSyncObject(input: {
    deviceId: string;
    afterSequence?: number;
    driveFileId: string;
    objectKind: SyncObjectMetadata['objectKind'];
    sha256: string;
    sizeBytes: number;
    operationId?: string | null;
    keyEpoch?: number;
  }): Promise<SyncObjectMetadata> {
    const existing = this.objects.find(object => object.operationId === input.operationId);
    if (existing) return existing;
    this.account.currentSyncSequence += 1;
    const object: SyncObjectMetadata = {
      id: `object-${this.account.currentSyncSequence}`,
      accountId: 'account-1',
      sequence: this.account.currentSyncSequence,
      driveFileId: input.driveFileId,
      objectKind: input.objectKind,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      createdByDeviceId: input.deviceId,
      createdAt: '2026-07-08T00:00:02.000Z',
      operationId: input.operationId || null,
      keyEpoch: input.keyEpoch || this.account.currentKeyEpoch || 1,
    };
    this.objects.push(object);
    return object;
  }

  async finalizeDeviceKeyRotation(input: {
    primaryDeviceId: string;
    rotationId: string;
    keyPackageSequence: number;
  }): Promise<{ account: SyncAccount; rotation: KeyEpochRotation; revocation: { accountId: string; deviceId: string; reason: string; createdAt: string } }> {
    this.finalizeCalls += 1;
    if (this.failFinalizeOnceWith) {
      const message = this.failFinalizeOnceWith;
      this.failFinalizeOnceWith = '';
      throw new Error(message);
    }
    if (!this.rotation || this.rotation.id !== input.rotationId || this.rotation.status !== 'pending') {
      throw new Error('key_rotation_not_pending');
    }
    this.rotation = {
      ...this.rotation,
      status: 'finalized',
      keyPackageSequence: input.keyPackageSequence,
      finalizedAt: '2026-07-08T00:00:03.000Z',
    };
    this.account = { ...this.account, currentKeyEpoch: this.rotation.nextKeyEpoch };
    this.devices = this.devices.map(device => (
      device.id === this.rotation?.revokedDeviceId
        ? { ...device, revokedAt: '2026-07-08T00:00:03.000Z' }
        : device
    ));
    return {
      account: { ...this.account },
      rotation: { ...this.rotation },
      revocation: {
        accountId: 'account-1',
        deviceId: this.rotation.revokedDeviceId,
        reason: this.rotation.reason,
        createdAt: '2026-07-08T00:00:03.000Z',
      },
    };
  }

  async updateDeviceCursor(input: { deviceId: string; lastAppliedSequence: number }): Promise<SyncDeviceCursor> {
    this.cursorUpdates.push(input.lastAppliedSequence);
    return {
      accountId: 'account-1',
      deviceId: input.deviceId,
      lastAppliedSequence: input.lastAppliedSequence,
      updatedAt: '2026-07-08T00:00:04.000Z',
    };
  }
}

const setupPrimaryAccount = async () => {
  const repository = await createRepository();
  const secretStorage = new MemorySecretStorage();
  const primary = await createDevice('primary-1', 'primary_mobile', 'Pixel Primary');
  const target = await createDevice('companion-1', 'web_companion', 'Old browser');
  const survivor = await createDevice('companion-2', 'web_companion', 'Daily browser');
  const state = createState(primary);
  await repository.saveLocalSyncAccountState(state);

  const rootKey = generateAccountRootKey();
  await saveSyncSecrets({
    version: 1,
    accountId: 'account-1',
    accountRootKey: rootKey,
    accountRootKeys: { 1: rootKey },
    devicePrivateKeyJwk: primary.privateKeyJwk,
    supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh' },
  }, secretStorage);

  const recoveryBytes = encodeRecoveryKeyPackage(await wrapAccountRootKeyForRecovery(
    rootKey,
    'a durable recovery passphrase',
    { accountId: 'account-1', keyVersion: 1 },
  ));
  const recoveryObject: SyncObjectMetadata = {
    id: 'recovery-object-0',
    accountId: 'account-1',
    sequence: 5,
    driveFileId: 'drive-recovery-0',
    objectKind: 'key_package',
    sha256: await sha256Hex(recoveryBytes),
    sizeBytes: recoveryBytes.byteLength,
    createdByDeviceId: 'primary-1',
    createdAt: '2026-07-08T00:00:00.000Z',
    operationId: null,
    keyEpoch: 1,
  };
  const controlPlane = new FakeControlPlane();
  controlPlane.devices = [primary, target, survivor];
  controlPlane.recoveryObjects = [recoveryObject];

  return {
    repository,
    secretStorage,
    primary,
    target,
    survivor,
    rootKey,
    recoveryBytes,
    controlPlane,
  };
};

const createRecordingUpload = (uploads: Map<string, Uint8Array>) => {
  let nextUpload = 0;
  return async (input: UploadDriveSyncObjectInput): Promise<DriveSyncObjectSummary> => {
    nextUpload += 1;
    const id = input.appProperties?.purpose === 'recovery'
      ? `drive-recovery-${nextUpload}`
      : `drive-companion-${nextUpload}`;
    uploads.set(id, input.bytes);
    return {
      id,
      name: input.name,
      size: input.bytes.byteLength,
      appProperties: Object.fromEntries(
        Object.entries(input.appProperties || {}).map(([key, value]) => [key, String(value)]),
      ),
    };
  };
};

test('resume aborts a begun rotation before recovery package commit', async () => {
  const fixture = await setupPrimaryAccount();
  const uploads = new Map<string, Uint8Array>();

  await assert.rejects(
    () => revokeDeviceWithKeyRotation({
      repository: fixture.repository,
      controlPlane: fixture.controlPlane,
      googleSession,
      secretStorage: fixture.secretStorage,
      targetDevice: fixture.target,
      recoveryPassphrase: 'a durable recovery passphrase',
      download: async (_session, fileId) => {
        assert.equal(fileId, 'drive-recovery-0');
        return fixture.recoveryBytes;
      },
      upload: async input => {
        uploads.set('attempted', input.bytes);
        throw new Error('simulated process death after begin');
      },
      now: () => 1_000,
    }),
    /simulated process death/,
  );
  assert.equal((await loadPendingDeviceKeyRotation(fixture.secretStorage))?.phase, 'begun');
  assert.equal(fixture.controlPlane.rotation?.status, 'pending');

  const result = await resumePendingDeviceKeyRotation({
    repository: fixture.repository,
    controlPlane: fixture.controlPlane,
    secretStorage: fixture.secretStorage,
  });

  assert.equal(result.status, 'aborted');
  assert.equal(fixture.controlPlane.rotation?.status, 'aborted');
  assert.equal(fixture.controlPlane.account.currentKeyEpoch, 1);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.keyEpoch, 1);
  assert.equal(await loadPendingDeviceKeyRotation(fixture.secretStorage), null);
});

test('resume completes rotation after recovery package was committed', async () => {
  const fixture = await setupPrimaryAccount();
  const uploads = new Map<string, Uint8Array>();
  const upload = createRecordingUpload(uploads);

  await assert.rejects(
    () => revokeDeviceWithKeyRotation({
      repository: fixture.repository,
      controlPlane: fixture.controlPlane,
      googleSession,
      secretStorage: fixture.secretStorage,
      targetDevice: fixture.target,
      recoveryPassphrase: 'a durable recovery passphrase',
      download: async () => fixture.recoveryBytes,
      upload: async input => {
        if (input.appProperties?.targetDeviceId) throw new Error('simulated process death after recovery package');
        return upload(input);
      },
      now: () => 2_000,
    }),
    /simulated process death after recovery package/,
  );
  const pendingAfterCrash = await loadPendingDeviceKeyRotation(fixture.secretStorage);
  assert.equal(pendingAfterCrash?.phase, 'recovery_package_committed');
  assert.equal(pendingAfterCrash?.recoveryPackageDriveFileId, 'drive-recovery-1');

  const result = await resumePendingDeviceKeyRotation({
    repository: fixture.repository,
    controlPlane: fixture.controlPlane,
    googleSession,
    secretStorage: fixture.secretStorage,
    upload,
    now: () => 3_000,
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.keyEpoch, 2);
  assert.equal(fixture.controlPlane.account.currentKeyEpoch, 2);
  assert.equal(fixture.controlPlane.devices.find(device => device.id === fixture.target.id)?.revokedAt !== null, true);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.keyEpoch, 2);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.currentSyncSequence, 12);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.recoveryKeyDriveFileId, 'drive-recovery-1');
  const secrets = await loadSyncSecrets(fixture.secretStorage);
  assert.equal(secrets?.accountRootKey.byteLength, 32);
  assert.notDeepEqual(secrets?.accountRootKey, fixture.rootKey);
  assert.deepEqual(secrets?.accountRootKeys?.[1], fixture.rootKey);
  assert.equal(secrets?.accountRootKeys?.[2].byteLength, 32);
  assert.equal(fixture.controlPlane.objects.some(object => (
    object.operationId === `key-epoch:account-1:2:rotation-1:${fixture.survivor.id}`
  )), true);
  assert.deepEqual(fixture.controlPlane.cursorUpdates, [12]);
  assert.equal(await loadPendingDeviceKeyRotation(fixture.secretStorage), null);
});

test('resume promotes when finalize already succeeded before local cleanup', async () => {
  const fixture = await setupPrimaryAccount();
  const nextRootKey = generateAccountRootKey();
  const pending: PendingDeviceKeyRotation = {
    version: 1,
    phase: 'future_key_staged',
    accountId: 'account-1',
    primaryDeviceId: fixture.primary.id,
    revokedDeviceId: fixture.target.id,
    revokedDeviceDisplayName: fixture.target.displayName,
    reason: 'revoked_by_primary',
    rotationId: 'rotation-1',
    nextKeyEpoch: 2,
    currentKeyEpoch: 1,
    startingSequence: 10,
    lastKeyPackageSequence: 12,
    keyVersion: 2,
    nextRootKeyBase64: encodeSyncSecretBytes(nextRootKey),
    recoveryPackageSequence: 11,
    recoveryPackageDriveFileId: 'drive-recovery-1',
    companionPackageDeviceIds: [fixture.survivor.id],
    startedAt: 1_000,
    updatedAt: 1_000,
  };
  await savePendingDeviceKeyRotationSecret(pending, fixture.secretStorage);
  const secrets = await loadSyncSecrets(fixture.secretStorage);
  await saveSyncSecrets({
    ...secrets!,
    accountRootKeys: {
      ...(secrets!.accountRootKeys || {}),
      2: nextRootKey,
    },
  }, fixture.secretStorage);
  fixture.controlPlane.rotation = {
    id: 'rotation-1',
    accountId: 'account-1',
    primaryDeviceId: fixture.primary.id,
    revokedDeviceId: fixture.target.id,
    reason: 'revoked_by_primary',
    nextKeyEpoch: 2,
    startingSequence: 10,
    keyPackageSequence: 12,
    status: 'pending',
    createdAt: '2026-07-08T00:00:00.000Z',
    finalizedAt: null,
  };
  fixture.controlPlane.lookupEpochs = [1, 2];
  fixture.controlPlane.failFinalizeOnceWith = 'key_rotation_not_pending';
  fixture.controlPlane.account = {
    ...fixture.controlPlane.account,
    currentKeyEpoch: 2,
    currentSyncSequence: 12,
  };

  const result = await resumePendingDeviceKeyRotation({
    repository: fixture.repository,
    controlPlane: fixture.controlPlane,
    secretStorage: fixture.secretStorage,
  });

  assert.equal(result.status, 'completed');
  assert.equal(fixture.controlPlane.finalizeCalls, 1);
  assert.deepEqual((await loadSyncSecrets(fixture.secretStorage))?.accountRootKey, nextRootKey);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.keyEpoch, 2);
  assert.equal(await loadPendingDeviceKeyRotation(fixture.secretStorage), null);
});

test('resume promotes server-finalized rotation without Google Drive access', async () => {
  const fixture = await setupPrimaryAccount();
  const nextRootKey = generateAccountRootKey();
  await savePendingDeviceKeyRotationSecret<PendingDeviceKeyRotation>({
    version: 1,
    phase: 'server_finalized',
    accountId: 'account-1',
    primaryDeviceId: fixture.primary.id,
    revokedDeviceId: fixture.target.id,
    revokedDeviceDisplayName: fixture.target.displayName,
    reason: 'revoked_by_primary',
    rotationId: 'rotation-1',
    nextKeyEpoch: 2,
    currentKeyEpoch: 1,
    startingSequence: 10,
    lastKeyPackageSequence: 12,
    keyVersion: 2,
    nextRootKeyBase64: encodeSyncSecretBytes(nextRootKey),
    recoveryPackageSequence: 11,
    recoveryPackageDriveFileId: 'drive-recovery-1',
    companionPackageDeviceIds: [fixture.survivor.id],
    startedAt: 1_000,
    updatedAt: 1_000,
  }, fixture.secretStorage);
  const secrets = await loadSyncSecrets(fixture.secretStorage);
  await saveSyncSecrets({
    ...secrets!,
    accountRootKeys: {
      ...(secrets!.accountRootKeys || {}),
      2: nextRootKey,
    },
  }, fixture.secretStorage);
  fixture.controlPlane.account = {
    ...fixture.controlPlane.account,
    currentKeyEpoch: 2,
    currentSyncSequence: 12,
  };

  const result = await resumePendingDeviceKeyRotation({
    repository: fixture.repository,
    controlPlane: fixture.controlPlane,
    secretStorage: fixture.secretStorage,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual((await loadSyncSecrets(fixture.secretStorage))?.accountRootKey, nextRootKey);
  assert.equal((await fixture.repository.getLocalSyncAccountState())?.currentSyncSequence, 12);
  assert.equal(await loadPendingDeviceKeyRotation(fixture.secretStorage), null);
});
