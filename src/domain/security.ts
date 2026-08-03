import CryptoJS from 'crypto-js';
import type { GoogleAccountSession, SecurityConfig } from '../types';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';

export type PinLength = 4 | 8;

export const normalizeSecurityConfig = (
  config?: Partial<SecurityConfig> | null,
): SecurityConfig => ({
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
});

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
  verifyPin(config, pin) ? { ...config, isLocked: false } : null;

export const createInitialPin = (config: SecurityConfig, pin: string): SecurityConfig => {
  if (!isValidPin(pin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...config,
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
  return { ...config, ...createPinFields(newPin), isPinCreated: true, isLocked: false };
};

export const resetPinAfterVerifiedRecovery = (
  config: SecurityConfig,
  newPin: string,
): SecurityConfig => {
  if (!isValidPin(newPin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...config,
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
