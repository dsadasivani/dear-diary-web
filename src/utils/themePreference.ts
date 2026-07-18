import type { AppSettings } from '../types';

export type AppTheme = NonNullable<AppSettings['theme']>;

const THEME_STORAGE_KEY = 'deardiary_theme';

export const normalizeTheme = (theme?: string | null, fallback: AppTheme = 'light'): AppTheme =>
  theme === 'dark' || theme === 'light' ? theme : fallback;

export const getLocalThemePreference = (fallback: AppTheme = 'light'): AppTheme => {
  if (typeof window === 'undefined') return fallback;
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY), fallback);
  } catch {
    return fallback;
  }
};

export const applyThemePreference = (theme: AppTheme): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
};

export const setLocalThemePreference = (theme: AppTheme): void => {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme should still apply even when storage is unavailable.
    }
  }
  applyThemePreference(theme);
};
