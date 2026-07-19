import { afterEach, describe, expect, it } from 'vitest';
import { ACCENT_THEME_OPTIONS, DEFAULT_ACCENT_THEME_ID } from '../design/accentThemes';
import {
  ACCENT_THEME_STORAGE_KEY,
  applyAccentThemePreference,
  getLocalAccentThemePreference,
  setLocalAccentThemePreference,
} from './accentPreference';

const channel = (hex: string): number[] =>
  (hex.slice(1).match(/../g) || []).map((value) => Number.parseInt(value, 16) / 255);

const luminance = (hex: string): number => {
  const [red, green, blue] = channel(hex).map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
};

const contrast = (left: string, right: string): number => {
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
};

afterEach(() => {
  localStorage.removeItem(ACCENT_THEME_STORAGE_KEY);
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-accent-theme');
  document.documentElement.removeAttribute('style');
});

describe('accent preference', () => {
  it('uses Quiet Grove when there is no valid saved preference', () => {
    expect(getLocalAccentThemePreference()).toBe(DEFAULT_ACCENT_THEME_ID);
    localStorage.setItem(ACCENT_THEME_STORAGE_KEY, 'unknown-palette');
    expect(getLocalAccentThemePreference()).toBe(DEFAULT_ACCENT_THEME_ID);
  });

  it('persists and immediately applies the selected light palette', () => {
    setLocalAccentThemePreference('warm-keepsake');

    expect(localStorage.getItem(ACCENT_THEME_STORAGE_KEY)).toBe('warm-keepsake');
    expect(document.documentElement.dataset.accentTheme).toBe('warm-keepsake');
    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#A44735');
  });

  it('applies the matching dark palette when dark mode is active', () => {
    document.documentElement.classList.add('dark');
    applyAccentThemePreference('still-waters');

    expect(document.documentElement.style.getPropertyValue('--color-primary')).toBe('#63D6C9');
    expect(document.documentElement.style.getPropertyValue('--color-on-primary')).toBe('#092B28');
  });

  it('keeps primary button text at WCAG AA contrast in every palette and mode', () => {
    for (const option of ACCENT_THEME_OPTIONS) {
      expect(contrast(option.light.primary, option.light.onPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(option.dark.primary, option.dark.onPrimary)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
