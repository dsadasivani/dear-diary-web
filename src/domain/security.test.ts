import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';
import {
  attemptPinUnlock,
  bindGoogleRecoveryAccount,
  clearPinLockout,
  createInitialPin,
  getPinLockoutStatus,
  normalizeSecurityConfig,
  PIN_LOCKOUT_POLICY,
  resetPinAfterVerifiedRecovery,
  unlockWithPin,
  updatePinWithCurrentPin,
  verifyPin,
} from './security';

test('creates, verifies, changes, and resets a PIN', () => {
  const configured = createInitialPin(DEFAULT_SECURITY_CONFIG, '1234');
  assert.equal(verifyPin(configured, '1234'), true);
  assert.equal(verifyPin(configured, '4321'), false);
  assert.equal(unlockWithPin(configured, '1234')?.isLocked, false);

  const changed = updatePinWithCurrentPin(configured, '1234', '87654321');
  assert.equal(verifyPin(changed, '87654321'), true);

  const recovered = resetPinAfterVerifiedRecovery(
    { ...changed, isBiometricsEnabled: true, passkeyCredentialId: 'credential' },
    '5555',
  );
  assert.equal(verifyPin(recovered, '5555'), true);
  assert.equal(recovered.isBiometricsEnabled, false);
  assert.equal(recovered.passkeyCredentialId, undefined);
});

test('normalization scrubs legacy recovery-question data', () => {
  const normalized = normalizeSecurityConfig({
    ...DEFAULT_SECURITY_CONFIG,
    recoveryQuestionId: 'first-pet',
    recoveryQuestionText: 'What was the name of your first pet?',
    recoveryAnswerHash: 'hash',
    recoveryAnswerSalt: 'salt',
    recoveryAnswerIterations: 120_000,
  } as Partial<typeof DEFAULT_SECURITY_CONFIG>);

  assert.equal('recoveryQuestionId' in normalized, false);
  assert.equal('recoveryQuestionText' in normalized, false);
  assert.equal('recoveryAnswerHash' in normalized, false);
  assert.equal('recoveryAnswerSalt' in normalized, false);
  assert.equal('recoveryAnswerIterations' in normalized, false);
  assert.equal(normalized.pinLockoutStage, 0);
  assert.equal(normalized.failedPinAttempts, 0);
});

test('normalization rejects malformed PIN lockout state', () => {
  const normalized = normalizeSecurityConfig({
    ...DEFAULT_SECURITY_CONFIG,
    pinLockoutStage: 99,
    failedPinAttempts: -4,
    pinLockedUntil: Number.NaN,
  } as any);

  assert.equal(normalized.pinLockoutStage, 0);
  assert.equal(normalized.failedPinAttempts, 0);
  assert.equal(normalized.pinLockedUntil, undefined);
});

test('escalates PIN failures through every lockout stage and repeats the final stage', () => {
  let config = createInitialPin(DEFAULT_SECURITY_CONFIG, '1234');
  let now = 1_000_000;

  PIN_LOCKOUT_POLICY.forEach((policy, stage) => {
    for (let attempt = 1; attempt < policy.maximumAttempts; attempt += 1) {
      const result = attemptPinUnlock(config, '9999', now);
      assert.equal(result.status, 'incorrect');
      if (result.status === 'incorrect') {
        assert.equal(result.attemptsRemaining, policy.maximumAttempts - attempt);
      }
      config = result.config;
    }

    const locked = attemptPinUnlock(config, '9999', now);
    assert.equal(locked.status, 'lockout-started');
    config = locked.config;
    assert.equal(config.pinLockedUntil, now + policy.lockoutMs);
    assert.equal(config.pinLockoutStage, Math.min(stage + 1, PIN_LOCKOUT_POLICY.length - 1));
    assert.equal(config.failedPinAttempts, 0);

    const ignored = attemptPinUnlock(config, '9999', now + 1);
    assert.equal(ignored.status, 'locked');
    assert.deepEqual(ignored.config, config);

    now += policy.lockoutMs;
    assert.equal(getPinLockoutStatus(config, now).isLockedOut, false);
  });

  const repeated = attemptPinUnlock(config, '9999', now);
  assert.equal(repeated.status, 'lockout-started');
  assert.equal(repeated.config.pinLockoutStage, 4);
  assert.equal(repeated.config.pinLockedUntil, now + PIN_LOCKOUT_POLICY[4].lockoutMs);
});

test('successful PIN and alternate unlocks clear all escalation state', () => {
  const configured = createInitialPin(DEFAULT_SECURITY_CONFIG, '1234');
  const escalated = {
    ...configured,
    pinLockoutStage: 4 as const,
    failedPinAttempts: 0,
    pinLockedUntil: 100_000,
  };

  const afterPin = attemptPinUnlock(escalated, '1234', 100_000);
  assert.equal(afterPin.status, 'unlocked');
  assert.equal(afterPin.config.pinLockoutStage, 0);
  assert.equal(afterPin.config.failedPinAttempts, 0);
  assert.equal(afterPin.config.pinLockedUntil, undefined);

  const afterAlternateUnlock = clearPinLockout(escalated);
  assert.equal(afterAlternateUnlock.pinLockoutStage, 0);
  assert.equal(afterAlternateUnlock.failedPinAttempts, 0);
  assert.equal(afterAlternateUnlock.pinLockedUntil, undefined);
});

test('pins Google recovery to the immutable linked account subject', () => {
  const first = bindGoogleRecoveryAccount(DEFAULT_SECURITY_CONFIG, {
    userId: 'google-user-1',
    email: 'writer@example.com',
  });
  assert.equal(first.ok, true);

  const sameSubject = bindGoogleRecoveryAccount(first.config, {
    userId: 'google-user-1',
    email: 'renamed@example.com',
  });
  assert.equal(sameSubject.ok, true);

  const mismatch = bindGoogleRecoveryAccount(first.config, {
    userId: 'google-user-2',
    email: 'other@example.com',
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error || '', /writer@example\.com/);
});
