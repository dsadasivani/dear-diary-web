import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_ROOT_KEY_BYTES,
  RECOVERY_PASSPHRASE_DIGIT_LENGTH,
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  isValidNewRecoveryPassphrase,
  unwrapAccountRootKeyFromRecovery,
  unwrapAccountRootKeysFromRecovery,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';

const passphrase = '12345678';
const legacyPassphrase = 'correct horse diary staple';

test('wraps and unwraps the account root key with the recovery passphrase', async () => {
  const rootKey = generateAccountRootKey();
  assert.equal(rootKey.length, ACCOUNT_ROOT_KEY_BYTES);

  const keyPackage = await wrapAccountRootKeyForRecovery(rootKey, passphrase, {
    accountId: 'account-1',
    createdAt: '2026-07-05T00:00:00.000Z',
  });
  const encoded = encodeRecoveryKeyPackage(keyPackage);
  const decoded = decodeRecoveryKeyPackage(encoded);

  assert.deepEqual(await unwrapAccountRootKeyFromRecovery(decoded, passphrase), rootKey);
});

test('requires a new recovery passphrase to be exactly 8 digits', () => {
  assert.equal(RECOVERY_PASSPHRASE_DIGIT_LENGTH, 8);
  assert.equal(isValidNewRecoveryPassphrase('12345678'), true);
  assert.equal(isValidNewRecoveryPassphrase('1234567'), false);
  assert.equal(isValidNewRecoveryPassphrase('123456789'), false);
  assert.equal(isValidNewRecoveryPassphrase('abcd5678'), false);
  assert.throws(() => validateRecoveryPassphrase('too-short'), /exactly 8 digits/i);
  assert.throws(() => validateRecoveryPassphrase('1234567a'), /exactly 8 digits/i);
});

test('still unwraps legacy recovery passphrases created before the 8 digit rule', async () => {
  const rootKey = generateAccountRootKey();
  const keyPackage = await wrapAccountRootKeyForRecovery(rootKey, legacyPassphrase, {
    accountId: 'account-1',
    createdAt: '2026-07-05T00:00:00.000Z',
  });

  assert.deepEqual(await unwrapAccountRootKeyFromRecovery(keyPackage, legacyPassphrase), rootKey);
});

test('rejects wrong passphrases and modified root-key packages', async () => {
  const rootKey = generateAccountRootKey();
  const keyPackage = await wrapAccountRootKeyForRecovery(rootKey, passphrase);

  await assert.rejects(
    () => unwrapAccountRootKeyFromRecovery(keyPackage, 'this passphrase is incorrect'),
    /incorrect|damaged/i,
  );

  const modified = { ...keyPackage, wrappedRootKey: `${keyPackage.wrappedRootKey.slice(0, -2)}AA` };
  await assert.rejects(
    () => unwrapAccountRootKeyFromRecovery(modified, passphrase),
    /incorrect|damaged/i,
  );
});

test('wraps and unwraps historical epoch root keys for recovery', async () => {
  const epochOneRootKey = generateAccountRootKey();
  const epochTwoRootKey = generateAccountRootKey();

  const keyPackage = await wrapAccountRootKeyForRecovery(epochTwoRootKey, passphrase, {
    accountId: 'account-1',
    keyEpoch: 2,
    keyVersion: 2,
    createdAt: '2026-07-05T00:00:00.000Z',
    accountRootKeys: {
      1: epochOneRootKey,
      2: epochTwoRootKey,
    },
  });

  const unwrapped = await unwrapAccountRootKeysFromRecovery(keyPackage, passphrase);
  assert.deepEqual(unwrapped.accountRootKey, epochTwoRootKey);
  assert.deepEqual(unwrapped.accountRootKeys[1], epochOneRootKey);
  assert.deepEqual(unwrapped.accountRootKeys[2], epochTwoRootKey);
});
