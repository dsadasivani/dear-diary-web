import type {
  AppSettings,
  BackupSchedulePreference,
  DriveBackupSettings,
  SecurityConfig,
  UserProfile,
} from '../types';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  remindersEnabled: false,
  reminderTime: '08:00 PM',
  theme: 'light',
  showAmbientLockScreen: false,
};

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  isPinCreated: false,
  pinHash: '',
  pinSalt: '',
  isBiometricsEnabled: false,
  isLocked: true,
};

const currentTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const createDefaultBackupSchedule = (): BackupSchedulePreference => ({
  mode: 'daily',
  localTime: '02:00',
  weeklyDay: new Date().getDay(),
  network: 'wifi',
  timezone: currentTimezone(),
});

export const createDefaultDriveBackupSettings = (): DriveBackupSettings => ({
  schedule: createDefaultBackupSchedule(),
  deviceId: globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  contentRevision: 0,
  stagedContentRevision: 0,
  uploadedContentRevision: 0,
  cloudWriteBlocked: false,
});

const nameFromEmail = (email?: string | null): string => (
  (email || '')
    .split('@')[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
);

export const createDefaultUserProfile = (email?: string | null): UserProfile => ({
  name: nameFromEmail(email) || 'Writer',
  email: email || '',
  bio: 'Savoring the simple, quiet moments of life.',
  avatarEmoji: '\uD83C\uDF38',
  avatarColor: '#8A3D55',
  writingGoal: 100,
  joinedDate: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
});
