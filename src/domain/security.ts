import CryptoJS from 'crypto-js';
import type { GoogleAccountSession, SecurityConfig } from '../types';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';

export type PinLength = 4 | 8;
export type PinLockoutStage = 0 | 1 | 2 | 3 | 4;

export const PIN_LOCKOUT_POLICY: ReadonlyArray<{
  maximumAttempts: number;
  lockoutMs: number;
}> = [
  { maximumAttempts: 10, lockoutMs: 15 * 60 * 1000 },
  { maximumAttempts: 5, lockoutMs: 30 * 60 * 1000 },
  { maximumAttempts: 3, lockoutMs: 60 * 60 * 1000 },
  { maximumAttempts: 2, lockoutMs: 60 * 60 * 1000 },
  { maximumAttempts: 1, lockoutMs: 60 * 60 * 1000 },
];

const normalizePinLockoutStage = (value: unknown): PinLockoutStage =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) < PIN_LOCKOUT_POLICY.length
    ? (Number(value) as PinLockoutStage)
    : 0;

const normalizeFailedPinAttempts = (value: unknown, stage: PinLockoutStage): number =>
  Number.isInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), PIN_LOCKOUT_POLICY[stage].maximumAttempts - 1)
    : 0;

export const normalizeSecurityConfig = (
  config?: Partial<SecurityConfig> | null,
): SecurityConfig => {
  const pinLockoutStage = normalizePinLockoutStage(config?.pinLockoutStage);
  const pinLockedUntil =
    typeof config?.pinLockedUntil === 'number' &&
    Number.isFinite(config.pinLockedUntil) &&
    config.pinLockedUntil > 0
      ? config.pinLockedUntil
      : undefined;
  return {
    isPinCreated: config?.isPinCreated ?? DEFAULT_SECURITY_CONFIG.isPinCreated,
    pinHash: config?.pinHash || DEFAULT_SECURITY_CONFIG.pinHash,
    pinSalt: config?.pinSalt || DEFAULT_SECURITY_CONFIG.pinSalt,
    ...(config?.pinLength ? { pinLength: config.pinLength } : {}),
    isBiometricsEnabled: config?.isBiometricsEnabled ?? DEFAULT_SECURITY_CONFIG.isBiometricsEnabled,
    isLocked: config?.isLocked ?? DEFAULT_SECURITY_CONFIG.isLocked,
    ...(config?.passkeyCredentialId ? { passkeyCredentialId: config.passkeyCredentialId } : {}),
    ...(config?.isBiometricsSimulated !== undefined
      ? { isBiometricsSimulated: config.isBiometricsSimulated }
      : {}),
    ...(config?.linkedGoogleUserId ? { linkedGoogleUserId: config.linkedGoogleUserId } : {}),
    ...(config?.linkedGoogleEmail !== undefined
      ? { linkedGoogleEmail: config.linkedGoogleEmail }
      : {}),
    ...(config?.linkedGoogleBoundAt ? { linkedGoogleBoundAt: config.linkedGoogleBoundAt } : {}),
    pinLockoutStage,
    failedPinAttempts: normalizeFailedPinAttempts(config?.failedPinAttempts, pinLockoutStage),
    ...(pinLockedUntil ? { pinLockedUntil } : {}),
  };
};

export interface PinLockoutStatus {
  isLockedOut: boolean;
  lockedUntil?: number;
  remainingMs: number;
}

export const getPinLockoutStatus = (config: SecurityConfig, now = Date.now()): PinLockoutStatus => {
  const lockedUntil = config.pinLockedUntil;
  const remainingMs = lockedUntil ? Math.max(0, lockedUntil - now) : 0;
  return {
    isLockedOut: remainingMs > 0,
    ...(remainingMs > 0 && lockedUntil ? { lockedUntil } : {}),
    remainingMs,
  };
};

export const clearPinLockout = (config: SecurityConfig): SecurityConfig => ({
  ...config,
  pinLockoutStage: 0,
  failedPinAttempts: 0,
  pinLockedUntil: undefined,
});

export const recordFailedPinAttempt = (
  config: SecurityConfig,
  now = Date.now(),
): SecurityConfig => {
  if (getPinLockoutStatus(config, now).isLockedOut) return config;

  const normalized = normalizeSecurityConfig(config);
  const stage = normalized.pinLockoutStage || 0;
  const policy = PIN_LOCKOUT_POLICY[stage];
  const failedPinAttempts = (normalized.failedPinAttempts || 0) + 1;
  if (failedPinAttempts < policy.maximumAttempts) {
    return { ...normalized, failedPinAttempts, pinLockedUntil: undefined };
  }

  return {
    ...normalized,
    pinLockoutStage: Math.min(stage + 1, PIN_LOCKOUT_POLICY.length - 1) as PinLockoutStage,
    failedPinAttempts: 0,
    pinLockedUntil: now + policy.lockoutMs,
  };
};

export type PinUnlockAttemptResult =
  | { status: 'unlocked'; config: SecurityConfig }
  | { status: 'incorrect'; config: SecurityConfig; attemptsRemaining: number }
  | { status: 'lockout-started'; config: SecurityConfig; lockedUntil: number }
  | { status: 'locked'; config: SecurityConfig; lockedUntil: number };

export const isValidPin = (pin: string, pinLength?: PinLength): boolean =>
  pinLength ? new RegExp(`^\\d{${pinLength}}$`).test(pin) : /^(\d{4}|\d{8})$/.test(pin);

const hashPin = (pin: string, salt: string): string => CryptoJS.SHA256(pin + salt).toString();

const createPinFields = (
  pin: string,
): Pick<SecurityConfig, 'pinHash' | 'pinSalt' | 'pinLength'> => {
  const pinSalt = CryptoJS.lib.WordArray.random(16).toString();
  return {
    pinHash: hashPin(pin, pinSalt),
    pinSalt,
    pinLength: pin.length === 8 ? 8 : 4,
  };
};

export const verifyPin = (config: SecurityConfig, pin: string): boolean =>
  config.isPinCreated &&
  (!config.pinLength || pin.length === config.pinLength) &&
  hashPin(pin, config.pinSalt) === config.pinHash;

export const unlockWithPin = (config: SecurityConfig, pin: string): SecurityConfig | null =>
  verifyPin(config, pin) ? { ...clearPinLockout(config), isLocked: false } : null;

export const attemptPinUnlock = (
  config: SecurityConfig,
  pin: string,
  now = Date.now(),
): PinUnlockAttemptResult => {
  const currentLockout = getPinLockoutStatus(config, now);
  if (currentLockout.isLockedOut && currentLockout.lockedUntil) {
    return { status: 'locked', config, lockedUntil: currentLockout.lockedUntil };
  }

  const availableConfig = currentLockout.isLockedOut
    ? config
    : { ...config, pinLockedUntil: undefined };
  const unlocked = unlockWithPin(availableConfig, pin);
  if (unlocked) return { status: 'unlocked', config: unlocked };

  const failed = recordFailedPinAttempt(availableConfig, now);
  const nextLockout = getPinLockoutStatus(failed, now);
  if (nextLockout.isLockedOut && nextLockout.lockedUntil) {
    return {
      status: 'lockout-started',
      config: failed,
      lockedUntil: nextLockout.lockedUntil,
    };
  }

  const stage = failed.pinLockoutStage || 0;
  return {
    status: 'incorrect',
    config: failed,
    attemptsRemaining: PIN_LOCKOUT_POLICY[stage].maximumAttempts - (failed.failedPinAttempts || 0),
  };
};

export const createInitialPin = (config: SecurityConfig, pin: string): SecurityConfig => {
  if (!isValidPin(pin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...clearPinLockout(config),
    isPinCreated: true,
    ...createPinFields(pin),
    isBiometricsEnabled: false,
    passkeyCredentialId: undefined,
    isBiometricsSimulated: undefined,
    isLocked: false,
  };
};

export const updatePinWithCurrentPin = (
  config: SecurityConfig,
  currentPin: string,
  newPin: string,
): SecurityConfig => {
  if (!verifyPin(config, currentPin)) throw new Error('Current PIN is incorrect.');
  if (!isValidPin(newPin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...clearPinLockout(config),
    ...createPinFields(newPin),
    isPinCreated: true,
    isLocked: false,
  };
};

export const resetPinAfterVerifiedRecovery = (
  config: SecurityConfig,
  newPin: string,
): SecurityConfig => {
  if (!isValidPin(newPin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...clearPinLockout(config),
    ...createPinFields(newPin),
    isPinCreated: true,
    isBiometricsEnabled: false,
    passkeyCredentialId: undefined,
    isBiometricsSimulated: undefined,
    isLocked: false,
  };
};

export const bindGoogleRecoveryAccount = (
  config: SecurityConfig,
  user: Pick<GoogleAccountSession, 'userId' | 'email'>,
): { ok: boolean; config: SecurityConfig; error?: string } => {
  const linkedUserId = config.linkedGoogleUserId;
  if (linkedUserId && linkedUserId !== user.userId) {
    return {
      ok: false,
      config,
      error: `This device is linked to ${config.linkedGoogleEmail || 'another Google account'}. Please sign in with that account.`,
    };
  }

  return {
    ok: true,
    config: {
      ...config,
      linkedGoogleUserId: linkedUserId || user.userId,
      linkedGoogleEmail: config.linkedGoogleEmail || user.email,
      linkedGoogleBoundAt: config.linkedGoogleBoundAt || Date.now(),
    },
  };
};
