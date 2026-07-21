import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NATIVE_BACKGROUND_PRIVACY_LOCK_MS,
  shouldLockAfterBackground,
} from './privacyLock';

test('native privacy lock allows transient background interruptions', () => {
  assert.equal(
    shouldLockAfterBackground({
      backgroundedAt: 1_000,
      resumedAt: 1_000 + DEFAULT_NATIVE_BACKGROUND_PRIVACY_LOCK_MS - 1,
    }),
    false,
  );
});

test('native privacy lock locks after the configured background interval', () => {
  assert.equal(
    shouldLockAfterBackground({
      backgroundedAt: 1_000,
      resumedAt: 1_000 + DEFAULT_NATIVE_BACKGROUND_PRIVACY_LOCK_MS,
    }),
    true,
  );
});

test('native privacy lock ignores resume without a known background timestamp', () => {
  assert.equal(
    shouldLockAfterBackground({
      backgroundedAt: null,
      resumedAt: 1_000,
    }),
    false,
  );
});
