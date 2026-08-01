export type AccentThemeId =
  'quiet-grove' | 'still-waters' | 'warm-keepsake' | 'velvet-memory' | 'twilight-ink';

export type AccentThemeMode = 'light' | 'dark';

export interface AccentThemeColors {
  primary: string;
  hover: string;
  container: string;
  onContainer: string;
  onPrimary: string;
  focus: string;
  glow: string;
}

export interface AccentThemeOption {
  id: AccentThemeId;
  name: string;
  description: string;
  light: AccentThemeColors;
  dark: AccentThemeColors;
}

export const DEFAULT_ACCENT_THEME_ID: AccentThemeId = 'quiet-grove';

export const ACCENT_THEME_OPTIONS: readonly AccentThemeOption[] = [
  {
    id: 'quiet-grove',
    name: 'Quiet Grove',
    description: 'Calm, grounded evergreen',
    light: {
      primary: '#2E6B62',
      hover: '#24574F',
      container: '#DCEBE6',
      onContainer: '#1F4E47',
      onPrimary: '#FFFFFF',
      focus: '#2E6B62',
      glow: 'rgba(46, 107, 98, 0.12)',
    },
    dark: {
      primary: '#6FC0AE',
      hover: '#85D0BE',
      container: '#1D403A',
      onContainer: '#C9F1E7',
      onPrimary: '#0C2924',
      focus: '#85D0BE',
      glow: 'rgba(111, 192, 174, 0.12)',
    },
  },
  {
    id: 'still-waters',
    name: 'Still Waters',
    description: 'Peaceful, clear deep teal',
    light: {
      primary: '#0B7068',
      hover: '#095C56',
      container: '#DCF4F1',
      onContainer: '#064D48',
      onPrimary: '#FFFFFF',
      focus: '#095C56',
      glow: 'rgba(11, 112, 104, 0.15)',
    },
    dark: {
      primary: '#63D6C9',
      hover: '#7DE2D7',
      container: '#153E3A',
      onContainer: '#CEFFF9',
      onPrimary: '#092B28',
      focus: '#91ECE2',
      glow: 'rgba(99, 214, 201, 0.15)',
    },
  },
  {
    id: 'warm-keepsake',
    name: 'Warm Keepsake',
    description: 'Nostalgic, sun-warmed clay',
    light: {
      primary: '#A44735',
      hover: '#883A2D',
      container: '#F9E7E1',
      onContainer: '#692C21',
      onPrimary: '#FFFFFF',
      focus: '#883A2D',
      glow: 'rgba(164, 71, 53, 0.15)',
    },
    dark: {
      primary: '#F09A83',
      hover: '#F5AE9B',
      container: '#4A2922',
      onContainer: '#FFE1D8',
      onPrimary: '#35130C',
      focus: '#FFC0AF',
      glow: 'rgba(240, 154, 131, 0.15)',
    },
  },
  {
    id: 'velvet-memory',
    name: 'Velvet Memory',
    description: 'Intimate, expressive mulberry',
    light: {
      primary: '#86395E',
      hover: '#6F2E4D',
      container: '#F6E5ED',
      onContainer: '#591C3B',
      onPrimary: '#FFFFFF',
      focus: '#6F2E4D',
      glow: 'rgba(134, 57, 94, 0.15)',
    },
    dark: {
      primary: '#F092B6',
      hover: '#F5A9C5',
      container: '#4B2435',
      onContainer: '#FFDFEA',
      onPrimary: '#35101F',
      focus: '#FFC0D5',
      glow: 'rgba(240, 146, 182, 0.15)',
    },
  },
  {
    id: 'twilight-ink',
    name: 'Twilight Ink',
    description: 'Dreamy, familiar violet',
    light: {
      primary: '#6C5CE7',
      hover: '#5C4CD8',
      container: '#ECE9FF',
      onContainer: '#3E318F',
      onPrimary: '#FFFFFF',
      focus: '#4F3ED0',
      glow: 'rgba(108, 92, 231, 0.16)',
    },
    dark: {
      primary: '#9A8CFF',
      hover: '#AA9EFF',
      container: '#302A5D',
      onContainer: '#E5E0FF',
      onPrimary: '#18142E',
      focus: '#B5AAFF',
      glow: 'rgba(154, 140, 255, 0.16)',
    },
  },
] as const;

const ACCENT_THEME_BY_ID = new Map(ACCENT_THEME_OPTIONS.map((option) => [option.id, option]));

export const normalizeAccentThemeId = (
  value?: string | null,
  fallback: AccentThemeId = DEFAULT_ACCENT_THEME_ID,
): AccentThemeId =>
  ACCENT_THEME_BY_ID.has(value as AccentThemeId) ? (value as AccentThemeId) : fallback;

export const getAccentThemeOption = (id: AccentThemeId): AccentThemeOption =>
  ACCENT_THEME_BY_ID.get(id) || ACCENT_THEME_OPTIONS[0];

export const getAccentThemeColors = (id: AccentThemeId, mode: AccentThemeMode): AccentThemeColors =>
  getAccentThemeOption(id)[mode];
