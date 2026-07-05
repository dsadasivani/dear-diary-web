import { LocalNotifications } from '@capacitor/local-notifications';
import type { AppSettings } from '../types';
import { isNativePlatform } from '../platform';

const REMINDER_ID = 1001;

export type ReminderSyncStatus = 'scheduled' | 'disabled' | 'permission-denied' | 'unsupported' | 'error';

export interface ReminderCapability {
  supported: boolean;
  permission: 'granted' | 'denied' | 'prompt' | 'unsupported';
}

export const normalizeReminderTime = (time: string): string => {
  const { hour, minute } = parseReminderTime(time);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

export const getReminderCapability = async (): Promise<ReminderCapability> => {
  if (!isNativePlatform()) return { supported: false, permission: 'unsupported' };
  try {
    const permission = await LocalNotifications.checkPermissions();
    return {
      supported: true,
      permission: permission.display === 'granted'
        ? 'granted'
        : permission.display === 'denied'
          ? 'denied'
          : 'prompt',
    };
  } catch {
    return { supported: false, permission: 'unsupported' };
  }
};

export const requestReminderPermission = async (): Promise<boolean> => {
  if (!isNativePlatform()) return false;
  const permission = await LocalNotifications.requestPermissions();
  return permission.display === 'granted';
};

const parseReminderTime = (time: string): { hour: number; minute: number } => {
  const trimmed = time.trim();
  const amPmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

  if (amPmMatch) {
    let hour = Number(amPmMatch[1]);
    const minute = Number(amPmMatch[2]);
    const period = amPmMatch[3].toUpperCase();
    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const [hourRaw, minuteRaw] = trimmed.split(':');
  return {
    hour: Number(hourRaw) || 20,
    minute: Number(minuteRaw) || 0,
  };
};

export const syncReminderNotification = async (settings: AppSettings): Promise<ReminderSyncStatus> => {
  if (!isNativePlatform()) {
    return 'unsupported';
  }

  try {
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });

    if (!settings.remindersEnabled) {
      return 'disabled';
    }

    const permission = await LocalNotifications.requestPermissions();
    if (permission.display !== 'granted') {
      console.warn('Local notification permission was not granted.');
      return 'permission-denied';
    }

    const { hour, minute } = parseReminderTime(settings.reminderTime || '20:00');

    await LocalNotifications.schedule({
      notifications: [{
        id: REMINDER_ID,
        title: 'Dear Diary',
        body: 'Take a quiet moment to write today.',
        schedule: {
          on: { hour, minute },
          repeats: true,
        },
      }],
    });
    return 'scheduled';
  } catch (error) {
    console.warn('Failed to sync reminder notification:', error);
    return 'error';
  }
};
