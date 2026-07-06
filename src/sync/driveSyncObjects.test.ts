import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  uploadDriveSyncObject,
} from './driveSyncObjects';

test('uses multipart upload for small encrypted sync objects', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: 'small-file', name: '/events/1.ddevent' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const result = await uploadDriveSyncObject({
      session: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
      name: '/events/1.ddevent',
      objectKind: 'event',
      bytes: new Uint8Array([1, 2, 3]),
    });
    assert.equal(result.id, 'small-file');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /uploadType=multipart/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses resumable upload for large encrypted sync objects', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) {
      return new Response(null, {
        status: 200,
        headers: { Location: 'https://upload.example/session-1' },
      });
    }
    return new Response(JSON.stringify({ id: 'large-file', name: '/media/large.ddmedia', size: '5242881' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const result = await uploadDriveSyncObject({
      session: { userId: 'google-1', email: null, displayName: null, accessToken: 'token' },
      name: '/media/large.ddmedia',
      objectKind: 'media',
      bytes: new Uint8Array(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1),
    });
    assert.equal(result.id, 'large-file');
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /uploadType=resumable/);
    assert.equal(new Headers(calls[0].init.headers).get('X-Upload-Content-Length'), String(RESUMABLE_UPLOAD_THRESHOLD_BYTES + 1));
    assert.equal(calls[1].url, 'https://upload.example/session-1');
    assert.equal(calls[1].init.method, 'PUT');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
