import type { AppSettings, LocalRepositoryMetadata, SecurityConfig, UserProfile } from '../types';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  remindersEnabled: false,
  reminderTime: '08:00 PM',
  theme: 'light',
  showAmbientLockScreen: true,
};

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  isPinCreated: false,
  pinHash: '',
  pinSalt: '',
  isBiometricsEnabled: false,
  isLocked: true,
  pinLockoutStage: 0,
  failedPinAttempts: 0,
};

export const createDefaultLocalRepositoryMetadata = (): LocalRepositoryMetadata => ({
  deviceId:
    globalThis.crypto?.randomUUID?.() ||
    `device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  contentRevision: 0,
});

const nameFromEmail = (email?: string | null): string =>
  (email || '')
    .split('@')[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const createDefaultUserProfile = (email?: string | null): UserProfile => ({
  name: nameFromEmail(email) || 'Writer',
  email: email || '',
  bio: 'Savoring the simple, quiet moments of life.',
  avatarEmoji: '\uD83C\uDF38',
  avatarColor: '#8A3D55',
  writingGoal: 100,
  joinedDate: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
});
