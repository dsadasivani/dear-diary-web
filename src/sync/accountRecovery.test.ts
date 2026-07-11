import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncObjectMetadata } from '../types';
import { encodeCompanionKeyPackage, wrapRootKeyForCompanion } from './companionKeyPackage';
import { generateDeviceKeyPair } from './deviceKeys';
import { encodeRecoveryKeyPackage, wrapAccountRootKeyForRecovery } from './e2eeKeyPackage';
import { recoverAccountRootKey } from './accountRecovery';

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

test('skips newer companion packages when recovering with a passphrase package', async () => {
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const device = await generateDeviceKeyPair();
  const companionBytes = encodeCompanionKeyPackage(
    await wrapRootKeyForCompanion(rootKey, 'account-1', device.publicKey),
  );
  const recoveryBytes = encodeRecoveryKeyPackage(
    await wrapAccountRootKeyForRecovery(rootKey, 'a sufficiently long passphrase', { accountId: 'account-1' }),
  );
  const makeObject = async (sequence: number, id: string, bytes: Uint8Array): Promise<SyncObjectMetadata> => ({
    id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: id,
    objectKind: 'key_package', sha256: await sha256(bytes), sizeBytes: bytes.byteLength,
    createdByDeviceId: 'device-1', createdAt: '',
  });
  const objects = [
    await makeObject(9, 'companion', companionBytes),
    await makeObject(1, 'recovery', recoveryBytes),
  ];

  const recovered = await recoverAccountRootKey({
    objects,
    accountId: 'account-1',
    recoveryPassphrase: 'a sufficiently long passphrase',
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
    download: async (_session, id) => id === 'companion' ? companionBytes : recoveryBytes,
  });

  assert.deepEqual(recovered.accountRootKey, rootKey);
  assert.equal(recovered.object.driveFileId, 'recovery');
});

test('collects passphrase recovery keys across key epochs', async () => {
  const epochOneRootKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoRootKey = crypto.getRandomValues(new Uint8Array(32));
  const recoveryOneBytes = encodeRecoveryKeyPackage(
    await wrapAccountRootKeyForRecovery(epochOneRootKey, 'a sufficiently long passphrase', {
      accountId: 'account-1',
      keyEpoch: 1,
      keyVersion: 1,
    }),
  );
  const recoveryTwoBytes = encodeRecoveryKeyPackage(
    await wrapAccountRootKeyForRecovery(epochTwoRootKey, 'a sufficiently long passphrase', {
      accountId: 'account-1',
      keyEpoch: 2,
      keyVersion: 2,
    }),
  );
  const makeObject = async (
    sequence: number,
    id: string,
    bytes: Uint8Array,
    keyEpoch: number,
  ): Promise<SyncObjectMetadata> => ({
    id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: id,
    objectKind: 'key_package', sha256: await sha256(bytes), sizeBytes: bytes.byteLength,
    createdByDeviceId: 'device-1', createdAt: '', keyEpoch,
  });
  const objects = [
    await makeObject(1, 'recovery-1', recoveryOneBytes, 1),
    await makeObject(9, 'recovery-2', recoveryTwoBytes, 2),
  ];
  const files = new Map<string, Uint8Array>([
    ['recovery-1', recoveryOneBytes],
    ['recovery-2', recoveryTwoBytes],
  ]);

  const recovered = await recoverAccountRootKey({
    objects,
    accountId: 'account-1',
    recoveryPassphrase: 'a sufficiently long passphrase',
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
    download: async (_session, id) => files.get(id)!,
  });

  assert.equal(recovered.object.driveFileId, 'recovery-2');
  assert.deepEqual(recovered.accountRootKey, epochTwoRootKey);
  assert.deepEqual(recovered.accountRootKeys[1], epochOneRootKey);
  assert.deepEqual(recovered.accountRootKeys[2], epochTwoRootKey);
});

test('stops scanning recovery packages when newest package contains required epochs', async () => {
  const epochOneRootKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoRootKey = crypto.getRandomValues(new Uint8Array(32));
  const oldRecoveryBytes = encodeRecoveryKeyPackage(
    await wrapAccountRootKeyForRecovery(epochOneRootKey, 'a sufficiently long passphrase', {
      accountId: 'account-1',
      keyEpoch: 1,
      keyVersion: 1,
    }),
  );
  const latestRecoveryBytes = encodeRecoveryKeyPackage(
    await wrapAccountRootKeyForRecovery(epochTwoRootKey, 'a sufficiently long passphrase', {
      accountId: 'account-1',
      keyEpoch: 2,
      keyVersion: 2,
      accountRootKeys: {
        1: epochOneRootKey,
        2: epochTwoRootKey,
      },
    }),
  );
  const makeObject = async (
    sequence: number,
    id: string,
    bytes: Uint8Array,
    keyEpoch: number,
  ): Promise<SyncObjectMetadata> => ({
    id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: id,
    objectKind: 'key_package', sha256: await sha256(bytes), sizeBytes: bytes.byteLength,
    createdByDeviceId: 'device-1', createdAt: '', keyEpoch,
  });
  const objects = [
    await makeObject(1, 'recovery-1', oldRecoveryBytes, 1),
    await makeObject(9, 'recovery-2', latestRecoveryBytes, 2),
  ];
  const downloadedFileIds: string[] = [];
  const files = new Map<string, Uint8Array>([
    ['recovery-1', oldRecoveryBytes],
    ['recovery-2', latestRecoveryBytes],
  ]);

  const recovered = await recoverAccountRootKey({
    objects,
    accountId: 'account-1',
    recoveryPassphrase: 'a sufficiently long passphrase',
    googleSession: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
    download: async (_session, id) => {
      downloadedFileIds.push(id);
      return files.get(id)!;
    },
    requiredKeyEpoch: 2,
  });

  assert.deepEqual(downloadedFileIds, ['recovery-2']);
  assert.equal(recovered.object.driveFileId, 'recovery-2');
  assert.deepEqual(recovered.accountRootKey, epochTwoRootKey);
  assert.deepEqual(recovered.accountRootKeys[1], epochOneRootKey);
  assert.deepEqual(recovered.accountRootKeys[2], epochTwoRootKey);
});
