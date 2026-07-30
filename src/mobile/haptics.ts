import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { isNativePlatform } from '../platform';

export type HapticImpact = 'light' | 'medium' | 'heavy';

const impactStyles: Record<HapticImpact, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Light,
  heavy: ImpactStyle.Medium,
};

const fallbackPatterns: Record<HapticImpact, number> = {
  light: 4,
  medium: 8,
  heavy: 14,
};

let lastFeedbackAt = 0;
const MIN_FEEDBACK_INTERVAL_MS = 40;

export const triggerImpact = async (impact: HapticImpact = 'light'): Promise<void> => {
  try {
    const now = Date.now();
    if (now - lastFeedbackAt < MIN_FEEDBACK_INTERVAL_MS) return;
    lastFeedbackAt = now;

    if (isNativePlatform()) {
      if (impact === 'light') {
        await Haptics.selectionChanged();
      } else {
        await Haptics.impact({ style: impactStyles[impact] });
      }
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
      await Haptics.impact({ style: ImpactStyle.Light });
      return;
    }

    window.navigator?.vibrate?.(8);
  } catch {
    // Haptics are intentionally best-effort.
  }
};
