export type RootDestination = 'home' | 'diaries' | 'notes' | 'search' | 'stats';

export type AppScreen = 'list' | 'diaryDetail' | 'diarySettings' | 'entryEditor' | 'appSettings';

export type AppNavigationTarget =
  | { kind: 'root'; destination: RootDestination }
  | { kind: 'diary'; diaryId: string; entryId?: string }
  | { kind: 'diary-settings'; diaryId: string }
  | {
      kind: 'entry-editor';
      diaryId: string;
      entryId?: string;
      date?: string;
      prompt?: string;
    }
  | { kind: 'note'; noteId: string }
  | { kind: 'settings' };

export interface ResolvedNavigationState {
  activeTab: RootDestination;
  currentScreen: AppScreen;
  selectedDiaryId: string;
  selectedEntryId: string;
  selectedDate: string;
  selectedNoteId: string;
  selectedPrompt: string;
}

const emptySelection = {
  selectedDiaryId: '',
  selectedEntryId: '',
  selectedDate: '',
  selectedNoteId: '',
  selectedPrompt: '',
};

export const resolveNavigationTarget = (target: AppNavigationTarget): ResolvedNavigationState => {
  switch (target.kind) {
    case 'root':
      return {
        activeTab: target.destination,
        currentScreen: 'list',
        ...emptySelection,
      };
    case 'diary':
      return {
        activeTab: 'diaries',
        currentScreen: 'diaryDetail',
        ...emptySelection,
        selectedDiaryId: target.diaryId,
        selectedEntryId: target.entryId || '',
      };
    case 'diary-settings':
      return {
        activeTab: 'diaries',
        currentScreen: 'diarySettings',
        ...emptySelection,
        selectedDiaryId: target.diaryId,
      };
    case 'entry-editor':
      return {
        activeTab: 'diaries',
        currentScreen: 'entryEditor',
        ...emptySelection,
        selectedDiaryId: target.diaryId,
        selectedEntryId: target.entryId || '',
        selectedDate: target.date || '',
        selectedPrompt: target.prompt || '',
      };
    case 'note':
      return {
        activeTab: 'notes',
        currentScreen: 'list',
        ...emptySelection,
        selectedNoteId: target.noteId,
      };
    case 'settings':
      return {
        activeTab: 'stats',
        currentScreen: 'appSettings',
        ...emptySelection,
      };
  }
};

const rootDestinations = new Set<RootDestination>(['home', 'diaries', 'notes', 'search', 'stats']);

/**
 * Temporary adapter for legacy positional component callbacks. New navigation
 * code should construct an AppNavigationTarget directly.
 */
export const legacyNavigationTarget = (
  tab: string,
  screen = 'list',
  diaryId = '',
  entryId = '',
  date = '',
  noteId = '',
  prompt = '',
): AppNavigationTarget => {
  if (tab === 'diaries') {
    if (screen === 'diaryDetail' && diaryId) return { kind: 'diary', diaryId, entryId };
    if (screen === 'diarySettings' && diaryId) return { kind: 'diary-settings', diaryId };
    if (screen === 'entryEditor' && diaryId) {
      return { kind: 'entry-editor', diaryId, entryId, date, prompt };
    }
    return { kind: 'root', destination: 'diaries' };
  }

  if (tab === 'notes') {
    return noteId ? { kind: 'note', noteId } : { kind: 'root', destination: 'notes' };
  }

  if (tab === 'stats' && screen === 'appSettings') return { kind: 'settings' };
  if (rootDestinations.has(tab as RootDestination)) {
    return { kind: 'root', destination: tab as RootDestination };
  }
  return { kind: 'root', destination: 'home' };
};
