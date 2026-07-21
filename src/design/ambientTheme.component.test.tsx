import { describe, expect, it } from 'vitest';
import { deriveAmbientTheme, getAmbientTime } from './ambientTheme';

describe('Living Memories ambient theme', () => {
  it('uses controlled, contrast-safe palettes for mood and time inputs', () => {
    expect(deriveAmbientTheme({ mode: 'light', time: 'dawn', mood: 'joyful' })).toMatchObject({
      primary: '#D93F6B',
      heroStart: '#FFF0F4',
    });
    expect(deriveAmbientTheme({ mode: 'dark', time: 'night', mood: 'calm' })).toMatchObject({
      primary: '#49D7C7',
      heroStart: '#171A2B',
    });
  });

  it('preserves a journal color instead of replacing it with the app accent', () => {
    const theme = deriveAmbientTheme({
      mode: 'light',
      time: 'day',
      journalColor: '#705FE0',
    });
    expect(theme.primary).toBe('#705FE0');
  });

  it('uses the selected accent for neutral app atmosphere', () => {
    const theme = deriveAmbientTheme({
      mode: 'light',
      time: 'day',
      accentTheme: 'warm-keepsake',
    });
    expect(theme).toMatchObject({
      primary: '#A44735',
      heroStart: '#F9E7E1',
    });
  });

  it('derives stable local time segments', () => {
    expect(getAmbientTime(new Date(2026, 0, 1, 7))).toBe('dawn');
    expect(getAmbientTime(new Date(2026, 0, 1, 13))).toBe('day');
    expect(getAmbientTime(new Date(2026, 0, 1, 18))).toBe('dusk');
    expect(getAmbientTime(new Date(2026, 0, 1, 23))).toBe('night');
  });
});
