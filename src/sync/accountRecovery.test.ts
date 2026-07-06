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
