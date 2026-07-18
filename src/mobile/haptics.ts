import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { isNativePlatform } from '../platform';

export type HapticImpact = 'light' | 'medium' | 'heavy';

const impactStyles: Record<HapticImpact, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};

const fallbackPatterns: Record<HapticImpact, number> = {
  light: 10,
  medium: 18,
  heavy: 28,
};

export const triggerImpact = async (impact: HapticImpact = 'light'): Promise<void> => {
  try {
    if (isNativePlatform()) {
      await Haptics.impact({ style: impactStyles[impact] });
      return;
    }

    window.navigator?.vibrate?.(fallbackPatterns[impact]);
  } catch {
    // Haptics are supportive feedback; the action itself must always continue.
  }
};

export const triggerSuccess = async (): Promise<void> => {
  try {
    if (isNativePlatform()) {
      await Haptics.notification({ type: NotificationType.Success });
      return;
    }

    window.navigator?.vibrate?.([12, 30, 12]);
  } catch {
    // Haptics are intentionally best-effort.
  }
};
