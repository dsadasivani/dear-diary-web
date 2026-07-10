import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAccountRootKey } from './e2eeKeyPackage';
import { decryptSyncPayload, decryptSyncPayloadWithKnownKeys, encryptSyncPayload } from './encryptedSyncObject';

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

test('decrypts with recovered epoch keys when metadata points at the wrong epoch', async () => {
  const epochOneRootKey = generateAccountRootKey();
  const epochTwoRootKey = generateAccountRootKey();
  const payload = new TextEncoder().encode('epoch two payload');
  const encrypted = await encryptSyncPayload(epochTwoRootKey, 'manifest', payload, { keyEpoch: 2 });

  const decrypted = await decryptSyncPayloadWithKnownKeys(
    encrypted.bytes,
    epochOneRootKey,
    { 1: epochOneRootKey, 2: epochTwoRootKey },
    1,
  );

  assert.equal(decrypted.objectKind, 'manifest');
  assert.deepEqual(decrypted.payload, payload);
});
