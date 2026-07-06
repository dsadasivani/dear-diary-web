import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDeviceKeyPair } from './deviceKeys';
import { unwrapRootKeyForCompanion, wrapRootKeyForCompanion } from './companionKeyPackage';

test('wraps the account root key exclusively for one companion device', async () => {
  const companion = await generateDeviceKeyPair();
  const anotherDevice = await generateDeviceKeyPair();
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const keyPackage = await wrapRootKeyForCompanion(rootKey, 'account-1', companion.publicKey);

  assert.deepEqual(
    await unwrapRootKeyForCompanion(keyPackage, companion.publicKey, companion.privateKeyJwk),
    rootKey,
  );
  await assert.rejects(
    () => unwrapRootKeyForCompanion(keyPackage, anotherDevice.publicKey, anotherDevice.privateKeyJwk),
    /another device/,
  );
});
