import assert from 'node:assert/strict';
import test from 'node:test';
import { generateDeviceKeyPair } from './deviceKeys';
import {
  CompanionKeyPackageError,
  unwrapRootKeyForCompanion,
  unwrapRootKeysForCompanion,
  wrapRootKeyForCompanion,
} from './companionKeyPackage';

test('wraps the account root key exclusively for one companion device', async () => {
  const companion = await generateDeviceKeyPair();
  const anotherDevice = await generateDeviceKeyPair();
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const keyPackage = await wrapRootKeyForCompanion(rootKey, 'account-1', companion.publicKey, {
    keyEpoch: 3,
  });
  assert.equal(keyPackage.keyEpoch, 3);

  assert.deepEqual(
    await unwrapRootKeyForCompanion(keyPackage, companion.publicKey, companion.privateKeyJwk),
    rootKey,
  );
  await assert.rejects(
    () =>
      unwrapRootKeyForCompanion(
        { ...keyPackage, keyEpoch: 2 },
        companion.publicKey,
        companion.privateKeyJwk,
      ),
    /authentication failed/,
  );
  await assert.rejects(
    () =>
      unwrapRootKeyForCompanion(keyPackage, anotherDevice.publicKey, anotherDevice.privateKeyJwk),
    (error: unknown) =>
      error instanceof CompanionKeyPackageError && error.code === 'TARGET_DEVICE_MISMATCH',
  );
});

test('wraps retained epoch keys for a newly paired companion', async () => {
  const companion = await generateDeviceKeyPair();
  const epochOne = crypto.getRandomValues(new Uint8Array(32));
  const epochTwo = crypto.getRandomValues(new Uint8Array(32));
  const keyPackage = await wrapRootKeyForCompanion(epochTwo, 'account-1', companion.publicKey, {
    keyEpoch: 2,
    accountRootKeys: { 1: epochOne, 2: epochTwo },
  });

  const unwrapped = await unwrapRootKeysForCompanion(
    keyPackage,
    companion.publicKey,
    companion.privateKeyJwk,
  );

  assert.equal(unwrapped.keyEpoch, 2);
  assert.deepEqual(unwrapped.accountRootKey, epochTwo);
  assert.deepEqual(unwrapped.accountRootKeys[1], epochOne);
  assert.deepEqual(unwrapped.accountRootKeys[2], epochTwo);
});

test('wraps the mobile PIN verifier without exposing recovery or biometric metadata', async () => {
  const companion = await generateDeviceKeyPair();
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const pinVerifier = {
    version: 1 as const,
    pinHash: 'mobile-pin-hash',
    pinSalt: 'mobile-pin-salt',
    pinLength: 8 as const,
  };
  const keyPackage = await wrapRootKeyForCompanion(rootKey, 'account-1', companion.publicKey, {
    pinVerifier,
  });

  const serialized = JSON.stringify(keyPackage);
  assert.doesNotMatch(serialized, /mobile-pin-hash|mobile-pin-salt/);
  assert.deepEqual(
    (await unwrapRootKeysForCompanion(keyPackage, companion.publicKey, companion.privateKeyJwk))
      .pinVerifier,
    pinVerifier,
  );

  await assert.rejects(
    () =>
      unwrapRootKeysForCompanion(
        {
          ...keyPackage,
          wrappedPinVerifier: {
            ...keyPackage.wrappedPinVerifier!,
            ciphertext: `${keyPackage.wrappedPinVerifier!.ciphertext.slice(0, -2)}AA`,
          },
        },
        companion.publicKey,
        companion.privateKeyJwk,
      ),
    /authentication failed/,
  );
});
