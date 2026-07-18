import type { Entry, Mood } from '../types';

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
    name: 'Velvet Fig',
    hex: '#8A3D55',
    bgClass: 'bg-brand-pink',
    borderClass: 'border-brand-pink',
  },
  {
    name: 'Royal Sage',
    hex: '#4C6A58',
    bgClass: 'bg-brand-sage',
    borderClass: 'border-brand-sage',
  },
  {
    name: 'Terracotta',
    hex: '#B85C4B',
    bgClass: 'bg-brand-rose',
    borderClass: 'border-brand-rose',
  },
  {
    name: 'Warm Sand',
    hex: '#F3EFE9',
    bgClass: 'bg-brand-blush-light',
    borderClass: 'border-brand-border',
  },
  { name: 'Rich Amber', hex: '#D49B4E', bgClass: 'bg-[#D49B4E]', borderClass: 'border-[#C1883F]' },
  {
    name: 'Slate Lavender',
    hex: '#6C7598',
    bgClass: 'bg-[#6C7598]',
    borderClass: 'border-[#5A6384]',
  },
];

const localDateString = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const getTodayWordCount = (entries: Array<Pick<Entry, 'date' | 'wordCount'>>): number => {
  const today = localDateString(new Date());
  return entries
    .filter((entry) => entry.date === today)
    .reduce((sum, entry) => sum + (entry.wordCount || 0), 0);
};

export const calculateStreak = (entries: Array<Pick<Entry, 'date'>>): number => {
  if (entries.length === 0) return 0;

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const entryDates = new Set(entries.map((entry) => entry.date));
  const startDate = entryDates.has(localDateString(today)) ? today : yesterday;
  if (!entryDates.has(localDateString(startDate))) return 0;

  let streak = 0;
  const cursor = new Date(startDate);
  while (entryDates.has(localDateString(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
};
