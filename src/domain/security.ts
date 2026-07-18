import CryptoJS from 'crypto-js';
import type { GoogleAccountSession, SecurityConfig, SyncDeviceRole } from '../types';
import { DEFAULT_SECURITY_CONFIG } from '../repositories/defaults';

export type PinLength = 4 | 8;

export const SECURITY_RECOVERY_QUESTIONS = [
  { id: 'first-pet', question: 'What was the name of your first pet?' },
  { id: 'favorite-teacher', question: 'What was the name of your favorite teacher?' },
  { id: 'childhood-street', question: 'What street did you grow up on?' },
  { id: 'favorite-book', question: 'What was your favorite childhood book?' },
  { id: 'memorable-place', question: 'What place always feels like home?' },
];

const CUSTOM_RECOVERY_QUESTION_PREFIX = 'custom:';
const RECOVERY_ANSWER_ITERATIONS = 120_000;

export const normalizeSecurityConfig = (
  config?: Partial<SecurityConfig> | null,
): SecurityConfig => {
  const normalized = { ...DEFAULT_SECURITY_CONFIG, ...(config || {}) };
  if (!normalized.linkedGoogleUserId && normalized.linkedGoogleUid) {
    normalized.linkedGoogleUserId = normalized.linkedGoogleUid;
  }
  return normalized;
};

export const isValidPin = (pin: string, pinLength?: PinLength): boolean =>
  pinLength ? new RegExp(`^\\d{${pinLength}}$`).test(pin) : /^(\d{4}|\d{8})$/.test(pin);

export const normalizeRecoveryAnswer = (answer: string): string =>
  answer.trim().replace(/\s+/g, ' ').toLowerCase();

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

const hashRecoveryAnswer = (answer: string, salt: string, iterations: number): string =>
  CryptoJS.PBKDF2(normalizeRecoveryAnswer(answer), salt, {
    keySize: 256 / 32,
    iterations,
  }).toString();

const isCustomRecoveryQuestionId = (questionId: string): boolean =>
  questionId.startsWith(CUSTOM_RECOVERY_QUESTION_PREFIX);

const isValidRecoveryQuestion = (questionId: string, questionText?: string): boolean =>
  SECURITY_RECOVERY_QUESTIONS.some((question) => question.id === questionId) ||
  (isCustomRecoveryQuestionId(questionId) && Boolean(questionText?.trim()));

const createRecoveryFields = (
  questionId: string,
  answer: string,
  questionText?: string,
): Pick<
  SecurityConfig,
  | 'recoveryQuestionId'
  | 'recoveryQuestionText'
  | 'recoveryAnswerHash'
  | 'recoveryAnswerSalt'
  | 'recoveryAnswerIterations'
> => {
  if (!isValidRecoveryQuestion(questionId, questionText)) {
    throw new Error('Please choose a valid security question.');
  }
  if (!normalizeRecoveryAnswer(answer)) {
    throw new Error('Please enter a security answer.');
  }

  const answerSalt = CryptoJS.lib.WordArray.random(16).toString();
  return {
    recoveryQuestionId: questionId,
    recoveryQuestionText:
      questionText?.trim() ||
      SECURITY_RECOVERY_QUESTIONS.find((question) => question.id === questionId)?.question,
    recoveryAnswerHash: hashRecoveryAnswer(answer, answerSalt, RECOVERY_ANSWER_ITERATIONS),
    recoveryAnswerSalt: answerSalt,
    recoveryAnswerIterations: RECOVERY_ANSWER_ITERATIONS,
  };
};

export const createCustomRecoveryQuestionId = (): string =>
  `${CUSTOM_RECOVERY_QUESTION_PREFIX}${Date.now()}`;

const resolveRecoveryQuestionText = (config: SecurityConfig): string | undefined =>
  config.recoveryQuestionText?.trim() ||
  SECURITY_RECOVERY_QUESTIONS.find((question) => question.id === config.recoveryQuestionId)
    ?.question;

export const getRecoveryQuestionText = (config: SecurityConfig): string =>
  resolveRecoveryQuestionText(config) || 'Recovery question unavailable';

export const hasRecoveryQuestion = (config: SecurityConfig): boolean =>
  Boolean(
    config.recoveryQuestionId &&
    resolveRecoveryQuestionText(config) &&
    config.recoveryAnswerHash &&
    config.recoveryAnswerSalt &&
    config.recoveryAnswerIterations,
  );

export const requiresRecoveryQuestionForDevice = (
  config: SecurityConfig,
  deviceRole?: SyncDeviceRole,
): boolean =>
  config.isPinCreated &&
  !hasRecoveryQuestion(config) &&
  !config.linkedGoogleUserId &&
  !config.linkedGoogleUid &&
  deviceRole !== 'web_companion';

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

export const createInitialPinWithRecovery = (
  config: SecurityConfig,
  pin: string,
  questionId: string,
  answer: string,
  questionText?: string,
): SecurityConfig => {
  if (!isValidPin(pin)) throw new Error('PIN must be exactly 4 or 8 digits.');
  return {
    ...config,
    isPinCreated: true,
    ...createPinFields(pin),
    ...createRecoveryFields(questionId, answer, questionText),
    isBiometricsEnabled: false,
    passkeyCredentialId: undefined,
    isBiometricsSimulated: undefined,
    isLocked: false,
  };
};

export const withRecoveryQuestion = (
  config: SecurityConfig,
  questionId: string,
  answer: string,
  questionText?: string,
): SecurityConfig => {
  if (!config.isPinCreated)
    throw new Error('Please create a PIN before setting a recovery question.');
  return { ...config, ...createRecoveryFields(questionId, answer, questionText) };
};

export const verifyRecoveryAnswer = (config: SecurityConfig, answer: string): boolean => {
  if (!hasRecoveryQuestion(config)) return false;
  return (
    hashRecoveryAnswer(
      answer,
      config.recoveryAnswerSalt || '',
      config.recoveryAnswerIterations || RECOVERY_ANSWER_ITERATIONS,
    ) === config.recoveryAnswerHash
  );
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
  const linkedUserId = config.linkedGoogleUserId || config.linkedGoogleUid;
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
      linkedGoogleUid: undefined,
      linkedGoogleEmail: config.linkedGoogleEmail || user.email,
      linkedGoogleBoundAt: config.linkedGoogleBoundAt || Date.now(),
    },
  };
};
