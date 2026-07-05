import type { AppSettings, Mood } from '../types';
import { PREDEFINED_MOODS, PREDEFINED_TAGS } from './journalCatalog';

export const getTagsForSettings = (settings: AppSettings): string[] => (
  [...new Set([...PREDEFINED_TAGS, ...(settings.customTags || [])])]
);

export const getMoodsForSettings = (settings: AppSettings): Mood[] => {
  const existingNames = new Set(PREDEFINED_MOODS.map(mood => mood.name));
  return [
    ...PREDEFINED_MOODS,
    ...(settings.customMoods || []).filter(mood => !existingNames.has(mood.name)),
  ];
};
