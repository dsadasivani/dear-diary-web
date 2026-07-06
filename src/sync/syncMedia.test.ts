import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSyncMediaReference,
  decodeSyncMediaPayload,
  encodeSyncMediaPayload,
  parseSyncMediaReference,
} from './syncMedia';

test('round-trips binary media payloads without base64 expansion', () => {
  const bytes = Uint8Array.from([0, 1, 2, 128, 255]);
  const decoded = decodeSyncMediaPayload(encodeSyncMediaPayload('media-1', 'image/jpeg', bytes));
  assert.equal(decoded.mediaId, 'media-1');
  assert.equal(decoded.mimeType, 'image/jpeg');
  assert.deepEqual(decoded.bytes, bytes);
});

test('round-trips portable media references', () => {
  const reference = createSyncMediaReference(17, 'media-1');
  assert.deepEqual(parseSyncMediaReference(reference), { sequence: 17, mediaId: 'media-1' });
  assert.equal(parseSyncMediaReference('https://local/photo.jpg'), null);
});
