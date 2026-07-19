import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_ACCENT_THEME_ID,
  getAccentThemeColors,
  normalizeAccentThemeId,
  type AccentThemeId,
} from './accentThemes';

export type AmbientTime = 'dawn' | 'day' | 'dusk' | 'night';
export type AmbientMood = 'joyful' | 'calm' | 'reflective' | 'tender' | 'energized' | 'neutral';
export type AmbientMode = 'light' | 'dark';

export interface AmbientThemeInput {
  mode: AmbientMode;
  time: AmbientTime;
  mood?: AmbientMood | string | null;
  journalColor?: string | null;
  accentTheme?: AccentThemeId;
}

export interface AmbientTheme {
  primary: string;
  secondary: string;
  glow: string;
  secondaryGlow: string;
  heroStart: string;
  heroEnd: string;
}

const LIGHT_SUPPORTING_ACCENTS = [
  { color: '#D93F6B', container: '#FFF0F4', glow: 'rgba(217, 63, 107, 0.13)' },
  { color: '#0C8F80', container: '#E7FAF7', glow: 'rgba(12, 143, 128, 0.13)' },
] as const;

const DARK_SUPPORTING_ACCENTS = [
  { color: '#FF7A9A', container: '#351E2A', glow: 'rgba(255, 122, 154, 0.12)' },
  { color: '#49D7C7', container: '#163633', glow: 'rgba(73, 215, 199, 0.12)' },
] as const;

type AmbientAccent = { color: string; container: string; glow: string };

const getAmbientAccents = (
  mode: AmbientMode,
  accentTheme: AccentThemeId,
): [AmbientAccent, AmbientAccent, AmbientAccent] => {
  const base = getAccentThemeColors(accentTheme, mode);
  const supporting = mode === 'dark' ? DARK_SUPPORTING_ACCENTS : LIGHT_SUPPORTING_ACCENTS;
  return [{ color: base.primary, container: base.container, glow: base.glow }, ...supporting];
};

const moodAccentIndex = (mood?: string | null): number => {
  const normalized = mood?.trim().toLowerCase() || '';
  if (['joyful', 'happy', 'excited', 'tender', 'loved'].includes(normalized)) return 1;
  if (['calm', 'peaceful', 'grounded', 'energized', 'fresh'].includes(normalized)) return 2;
  return 0;
};

const parseHex = (value?: string | null): [number, number, number] | null => {
  const match = value?.trim().match(/^#([\da-f]{6})$/i);
  if (!match) return null;
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
};

const rgbToHex = (channels: [number, number, number]): string =>
  `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const mixRgb = (
  foreground: [number, number, number],
  background: [number, number, number],
  foregroundWeight: number,
): [number, number, number] =>
  foreground.map(
    (channel, index) => channel * foregroundWeight + background[index] * (1 - foregroundWeight),
  ) as [number, number, number];

const journalAmbientAccent = (
  journalColor: string | null | undefined,
  mode: AmbientMode,
): AmbientAccent | null => {
  const rgb = parseHex(journalColor);
  if (!rgb) return null;
  const container =
    mode === 'dark' ? mixRgb(rgb, [21, 24, 32], 0.25) : mixRgb(rgb, [255, 255, 255], 0.12);
  return {
    color: rgbToHex(rgb),
    container: rgbToHex(container),
    glow: `rgba(${rgb.join(', ')}, ${mode === 'dark' ? '0.14' : '0.13'})`,
  };
};

const nearestAccentIndex = (
  journalColor: string | null | undefined,
  accents: ReadonlyArray<{ color: string }>,
): number | null => {
  const source = parseHex(journalColor);
  if (!source) return null;
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  accents.forEach((accent, index) => {
    const target = parseHex(accent.color);
    if (!target) return;
    const distance = target.reduce(
      (sum, channel, channelIndex) => sum + (channel - source[channelIndex]) ** 2,
      0,
    );
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
};

export const getAmbientTime = (date = new Date()): AmbientTime => {
  const hour = date.getHours();
  if (hour < 6) return 'night';
  if (hour < 10) return 'dawn';
  if (hour < 17) return 'day';
  if (hour < 21) return 'dusk';
  return 'night';
};

export const deriveAmbientTheme = ({
  mode,
  time,
  mood,
  journalColor,
  accentTheme = DEFAULT_ACCENT_THEME_ID,
}: AmbientThemeInput): AmbientTheme => {
  const accents = getAmbientAccents(mode, accentTheme);
  const selectedIndex = moodAccentIndex(mood);
  const journalAccent = journalAmbientAccent(journalColor, mode);
  const selected = journalAccent || accents[selectedIndex];
  const nearestSupporting = journalAccent
    ? nearestAccentIndex(journalColor, accents.slice(1))
    : null;
  const secondary = journalAccent
    ? accents[nearestSupporting === 0 ? 2 : 1]
    : accents[selectedIndex === 1 ? 2 : 1];
  const timeContainer =
    time === 'dawn'
      ? accents[1].container
      : time === 'dusk'
        ? journalAccent?.container || accents[0].container
        : time === 'night'
          ? mode === 'dark'
            ? '#171A2B'
            : '#EEF1FF'
          : selected.container;

  return {
    primary: selected.color,
    secondary: secondary.color,
    glow: selected.glow,
    secondaryGlow: secondary.glow,
    heroStart: timeContainer,
    heroEnd: secondary.container,
  };
};

interface AmbientThemeContextValue {
  theme: AmbientTheme;
  setAmbientContext: (input: Partial<Omit<AmbientThemeInput, 'mode'>>) => void;
  resetAmbientContext: () => void;
}

const AmbientThemeContext = createContext<AmbientThemeContextValue | null>(null);

const readMode = (): AmbientMode =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';

const readAccentTheme = (): AccentThemeId =>
  typeof document === 'undefined'
    ? DEFAULT_ACCENT_THEME_ID
    : normalizeAccentThemeId(document.documentElement.dataset.accentTheme);

export function AmbientThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AmbientMode>(readMode);
  const [accentTheme, setAccentTheme] = useState<AccentThemeId>(readAccentTheme);
  const defaultContext = useMemo(
    () => ({ time: getAmbientTime(), mood: 'neutral' as AmbientMood, journalColor: null }),
    [],
  );
  const [context, setContext] = useState(defaultContext);
  const theme = useMemo(
    () => deriveAmbientTheme({ mode, accentTheme, ...context }),
    [accentTheme, context, mode],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const updateAppearance = () => {
      setMode(readMode());
      setAccentTheme(readAccentTheme());
    };
    const observer = new MutationObserver(updateAppearance);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'data-accent-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--ambient-primary', theme.primary);
    root.style.setProperty('--ambient-secondary', theme.secondary);
    root.style.setProperty('--ambient-glow', theme.glow);
    root.style.setProperty('--ambient-glow-secondary', theme.secondaryGlow);
    root.style.setProperty('--ambient-hero-start', theme.heroStart);
    root.style.setProperty('--ambient-hero-end', theme.heroEnd);
  }, [theme]);

  const setAmbientContext = useCallback(
    (input: Partial<Omit<AmbientThemeInput, 'mode'>>) =>
      setContext((current) => ({ ...current, ...input })),
    [],
  );
  const resetAmbientContext = useCallback(() => setContext(defaultContext), [defaultContext]);
  const value = useMemo(
    () => ({ theme, setAmbientContext, resetAmbientContext }),
    [resetAmbientContext, setAmbientContext, theme],
  );

  return <AmbientThemeContext.Provider value={value}>{children}</AmbientThemeContext.Provider>;
}

export const useAmbientTheme = (): AmbientThemeContextValue => {
  const context = useContext(AmbientThemeContext);
  if (!context) throw new Error('useAmbientTheme must be used within AmbientThemeProvider.');
  return context;
};
