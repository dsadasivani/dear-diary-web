import assert from 'node:assert/strict';
import test from 'node:test';
import { mapSupabaseError, SyncError } from './index';

test('maps provider status and codes without parsing external messages', () => {
  assert.equal(mapSupabaseError({ status: 401, message: 'anything' }).code, 'AUTH_EXPIRED');
  assert.equal(mapSupabaseError({ status: 503, message: 'anything' }).code, 'SERVER_UNAVAILABLE');
  assert.equal(
    mapSupabaseError({ code: 'RECORD_VERSION_CONFLICT', message: 'localized text' }).code,
    'RECORD_VERSION_CONFLICT',
  );
});

test('unknown provider errors retry without engaging an integrity safety stop', () => {
  const error = mapSupabaseError(new Error('private provider detail'));
  assert.equal(error.code, 'UNKNOWN');
  assert.equal(error.retryable, true);
  assert.equal(error.safetyRelevant, false);
  assert.equal(error.message.includes('private provider detail'), false);
  assert.ok(error instanceof SyncError);
});
