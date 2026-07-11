import type { Entry } from '../types';

export const resolveEntryIndexForEntryId = (
  diaryEntries: Pick<Entry, 'id'>[],
  entryId?: string,
): number => {
  if (!entryId) return 0;
  const index = diaryEntries.findIndex(entry => entry.id === entryId);
  return index >= 0 ? index : 0;
};
