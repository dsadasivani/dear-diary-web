import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_ROOT_KEY_BYTES,
  decodeRecoveryKeyPackage,
  encodeRecoveryKeyPackage,
  generateAccountRootKey,
  unwrapAccountRootKeyFromRecovery,
  validateRecoveryPassphrase,
  wrapAccountRootKeyForRecovery,
} from './e2eeKeyPackage';

const passphrase = 'correct horse diary staple';

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

test('requires a 12+ character recovery passphrase', async () => {
  assert.throws(() => validateRecoveryPassphrase('too-short'), /12 characters/i);
  await assert.rejects(
    () => wrapAccountRootKeyForRecovery(generateAccountRootKey(), 'too-short'),
    /12 characters/i,
  );
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
