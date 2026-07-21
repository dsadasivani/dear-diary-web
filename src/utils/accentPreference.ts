import {
  DEFAULT_ACCENT_THEME_ID,
  getAccentThemeColors,
  normalizeAccentThemeId,
  type AccentThemeId,
} from '../design/accentThemes';

export const ACCENT_THEME_STORAGE_KEY = 'deardiary_accent_theme';

export const getLocalAccentThemePreference = (
  fallback: AccentThemeId = DEFAULT_ACCENT_THEME_ID,
): AccentThemeId => {
  if (typeof window === 'undefined') return fallback;
  try {
    return normalizeAccentThemeId(window.localStorage.getItem(ACCENT_THEME_STORAGE_KEY), fallback);
  } catch {
    return fallback;
  }
};

export const applyAccentThemePreference = (accentTheme: AccentThemeId): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const mode = root.classList.contains('dark') ? 'dark' : 'light';
  const colors = getAccentThemeColors(accentTheme, mode);

  root.dataset.accentTheme = accentTheme;
  root.style.setProperty('--color-primary', colors.primary);
  root.style.setProperty('--color-primary-hover', colors.hover);
  root.style.setProperty('--color-primary-container', colors.container);
  root.style.setProperty('--color-primary-on-container', colors.onContainer);
  root.style.setProperty('--color-on-primary', colors.onPrimary);
  root.style.setProperty('--color-focus', colors.focus);
  root.style.setProperty('--ambient-primary', colors.primary);
  root.style.setProperty('--ambient-glow', colors.glow);
};

export const setLocalAccentThemePreference = (accentTheme: AccentThemeId): void => {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(ACCENT_THEME_STORAGE_KEY, accentTheme);
    } catch {
      // The accent should still apply when storage is unavailable.
    }
  }
  applyAccentThemePreference(accentTheme);
};
