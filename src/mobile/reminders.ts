import { LocalNotifications } from '@capacitor/local-notifications';
import type { AppSettings } from '../types';
import { isNativePlatform } from '../platform';

const REMINDER_ID = 1001;

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

export const syncReminderNotification = async (settings: AppSettings): Promise<void> => {
  if (!isNativePlatform()) {
    return;
  }

  try {
    await LocalNotifications.cancel({ notifications: [{ id: REMINDER_ID }] });

    if (!settings.remindersEnabled) {
      return;
    }

    const permission = await LocalNotifications.requestPermissions();
    if (permission.display !== 'granted') {
      console.warn('Local notification permission was not granted.');
      return;
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
  } catch (error) {
    console.warn('Failed to sync reminder notification:', error);
  }
};
