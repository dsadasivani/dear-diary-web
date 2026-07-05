import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptBackupWithPassphrase,
  encryptBackupWithPassphrase,
  inspectEncryptedEnvelope,
  isEncryptedBackupEnvelope,
} from './backupEncryption';

const password = 'a-correct-horse-battery-staple';

test('encrypts and authenticates a Dear Diary backup envelope', async () => {
  const original = new TextEncoder().encode('private journal payload');
  const encrypted = await encryptBackupWithPassphrase(original, password);
  assert.equal(isEncryptedBackupEnvelope(encrypted), true);
  assert.equal(inspectEncryptedEnvelope(encrypted).version, 1);
  assert.deepEqual(await decryptBackupWithPassphrase(encrypted, password), original);
});

test('rejects a wrong passphrase and modified ciphertext', async () => {
  const encrypted = await encryptBackupWithPassphrase(new Uint8Array([1, 2, 3, 4]), password);
  await assert.rejects(() => decryptBackupWithPassphrase(encrypted, 'this-password-is-wrong'), /incorrect|damaged/i);
  const modified = encrypted.slice();
  modified[modified.length - 1] ^= 1;
  await assert.rejects(() => decryptBackupWithPassphrase(modified, password), /authentication failed/i);
});

test('requires a strong-enough backup passphrase', async () => {
  await assert.rejects(() => encryptBackupWithPassphrase(new Uint8Array([1]), 'too-short'), /12 characters/i);
});
