import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';
import {
  bindGoogleRecoveryAccount,
  createInitialPin,
  normalizeSecurityConfig,
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
