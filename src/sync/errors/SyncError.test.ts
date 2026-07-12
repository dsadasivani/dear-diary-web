import assert from 'node:assert/strict';
import test from 'node:test';
import { mapDriveError, mapSupabaseError, SyncError } from './index';

test('maps provider status and codes without parsing external messages', () => {
  assert.equal(mapDriveError({ status: 401, message: 'anything' }).code, 'AUTH_EXPIRED');
  assert.equal(mapDriveError({ status: 503, message: 'anything' }).code, 'SERVER_UNAVAILABLE');
  assert.equal(mapSupabaseError({ code: 'RECORD_VERSION_CONFLICT', message: 'localized text' }).code, 'RECORD_VERSION_CONFLICT');
});

test('unknown errors default to a non-retryable safety-relevant failure', () => {
  const error = mapSupabaseError(new Error('private provider detail'));
  assert.equal(error.code, 'UNKNOWN');
  assert.equal(error.retryable, false);
  assert.equal(error.safetyRelevant, true);
  assert.equal(error.message.includes('private provider detail'), false);
  assert.ok(error instanceof SyncError);
});
