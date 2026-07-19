import type { Entry, Mood } from '../types';
import { calculateLocalStreak, toLocalDateKey } from '../utils/localDate';

export const PREDEFINED_MOODS: Mood[] = [
  { name: 'Joyful', emoji: '\uD83D\uDE0A' },
  { name: 'Calm', emoji: '\uD83D\uDE0C' },
  { name: 'Sad', emoji: '\uD83D\uDE22' },
  { name: 'Anxious', emoji: '\uD83D\uDE1F' },
  { name: 'Family', emoji: '\uD83C\uDFE0' },
];

export const PREDEFINED_TAGS = [
  'happy',
  'travel',
  'summer',
  'family',
  'calm',
  'dream',
  'reading',
  'errands',
  'quotes',
  'ideas',
  'thoughts',
];

export const PREDEFINED_COLORS = [
  {
    name: 'Memory Violet',
    hex: '#6C5CE7',
    bgClass: 'bg-accent',
    borderClass: 'border-accent',
  },
  {
    name: 'Living Coral',
    hex: '#D93F6B',
    bgClass: 'bg-[var(--color-secondary)]',
    borderClass: 'border-[var(--color-secondary)]',
  },
  {
    name: 'Fresh Teal',
    hex: '#0C8F80',
    bgClass: 'bg-[var(--color-tertiary)]',
    borderClass: 'border-[var(--color-tertiary)]',
  },
  {
    name: 'Midnight Ink',
    hex: '#30364A',
    bgClass: 'bg-[#30364A]',
    borderClass: 'border-[#30364A]',
  },
  {
    name: 'Luminous Sky',
    hex: '#4476C8',
    bgClass: 'bg-[#4476C8]',
    borderClass: 'border-[#4476C8]',
  },
  {
    name: 'Soft Orchid',
    hex: '#8A5FB5',
    bgClass: 'bg-[#8A5FB5]',
    borderClass: 'border-[#8A5FB5]',
  },
];

export const getTodayWordCount = (entries: Array<Pick<Entry, 'date' | 'wordCount'>>): number => {
  const today = toLocalDateKey();
  return entries
    .filter((entry) => entry.date === today)
    .reduce((sum, entry) => sum + (entry.wordCount || 0), 0);
};

export const calculateStreak = (entries: Array<Pick<Entry, 'date'>>): number =>
  calculateLocalStreak(entries.map((entry) => entry.date));
