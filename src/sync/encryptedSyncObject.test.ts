import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAccountRootKey } from './e2eeKeyPackage';
import { decryptSyncPayload, encryptSyncPayload } from './encryptedSyncObject';

test('encrypts sync payloads with the account root key and records a digest', async () => {
  const rootKey = generateAccountRootKey();
  const payload = new TextEncoder().encode(JSON.stringify({ hello: 'private journal' }));
  const encrypted = await encryptSyncPayload(rootKey, 'snapshot', payload);

  assert.match(encrypted.sha256, /^[a-f0-9]{64}$/);
  assert.notDeepEqual(encrypted.bytes, payload);

  const decrypted = await decryptSyncPayload(rootKey, encrypted.bytes);
  assert.equal(decrypted.objectKind, 'snapshot');
  assert.deepEqual(decrypted.payload, payload);
});

test('rejects modified sync ciphertext', async () => {
  const rootKey = generateAccountRootKey();
  const encrypted = await encryptSyncPayload(rootKey, 'event', new Uint8Array([1, 2, 3]));
  const envelope = JSON.parse(new TextDecoder().decode(encrypted.bytes));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  const modified = new TextEncoder().encode(JSON.stringify(envelope));

  await assert.rejects(
    () => decryptSyncPayload(rootKey, modified),
    /authentication failed/i,
  );
});
