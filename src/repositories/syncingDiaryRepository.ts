import type { AppSettings, Diary, Entry, Note, UserProfile } from '../types';
import type { DiaryRepository, NewDiary, NewEntry, NewNote } from './DiaryRepository';
import type { EventSyncEngine } from '../sync/eventSyncEngine';
import { richTextHtmlToPlainText, sanitizeEntry, sanitizeNote } from '../domain/richTextSanitizer';

const createId = (prefix: string): string => {
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
};

const countWords = (body: string): number => {
  const plainText = richTextHtmlToPlainText(body);
  return plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
};

const toSyncedSettingsPayload = (settings: AppSettings): AppSettings => {
  const { theme: _theme, ...syncedSettings } = settings;
  return syncedSettings;
};

export const createSyncingDiaryRepository = (
  localRepository: DiaryRepository,
  syncEngine: EventSyncEngine,
): DiaryRepository => new Proxy(localRepository, {
  get(target, property, receiver) {
    if (property === 'listDiaries') return async (): Promise<Diary[]> => (
      syncEngine.hydrateDiaries(await localRepository.listDiaries())
    );
    if (property === 'getDiary') return async (id: string): Promise<Diary | null> => {
      const diary = await localRepository.getDiary(id);
      return diary ? syncEngine.hydrateDiary(diary) : null;
    };
    if (property === 'listEntries') return async (): Promise<Entry[]> => (
      syncEngine.hydrateEntries(await localRepository.listEntries())
    );
    if (property === 'getEntry') return async (id: string): Promise<Entry | null> => {
      const entry = await localRepository.getEntry(id);
      return entry ? (await syncEngine.hydrateEntries([entry]))[0] : null;
    };
    if (property === 'getUserProfile') return async (): Promise<UserProfile> => (
      syncEngine.hydrateProfile(await localRepository.getUserProfile())
    );
    if (property === 'saveSettings') return async (settings: AppSettings): Promise<void> => {
      if (!await localRepository.getLocalSyncAccountState()) {
        await localRepository.saveSettings(settings);
        return;
      }
      await syncEngine.commitMutation('settings', 'upsert', 'settings', toSyncedSettingsPayload(settings));
    };
    if (property === 'saveUserProfile') return async (profile: UserProfile): Promise<void> => {
      if (!await localRepository.getLocalSyncAccountState()) {
        await localRepository.saveUserProfile(profile);
        return;
      }
      await syncEngine.commitMutation('profile', 'upsert', 'profile', profile);
    };
    if (property === 'createDiary') return async (input: NewDiary): Promise<Diary> => {
      const diary: Diary = { ...input, id: createId('diary'), entryCount: 0, lastUpdated: 'No entries yet' };
      await syncEngine.commitMutation('diary', 'upsert', diary.id, diary);
      return diary;
    };
    if (property === 'updateDiary') return async (diary: Diary): Promise<Diary | null> => {
      if (!await localRepository.getDiary(diary.id)) return null;
      await syncEngine.commitMutation('diary', 'upsert', diary.id, diary);
      const stored = await localRepository.getDiary(diary.id);
      return stored ? syncEngine.hydrateDiary(stored) : null;
    };
    if (property === 'deleteDiary') return async (id: string): Promise<boolean> => {
      if (!await localRepository.getDiary(id)) return false;
      await syncEngine.commitMutation('diary', 'delete', id, null);
      return true;
    };
    if (property === 'createEntry') return async (input: NewEntry): Promise<Entry> => {
      const timestamp = Date.now();
      const entry: Entry = sanitizeEntry({
        ...input,
        id: createId('entry'),
        wordCount: countWords(input.body || ''),
        photoCount: input.photoUris?.length || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      entry.wordCount = countWords(entry.body || '');
      await syncEngine.commitMutation('entry', 'upsert', entry.id, entry);
      return entry;
    };
    if (property === 'updateEntry') return async (entry: Entry): Promise<Entry | null> => {
      if (!await localRepository.getEntry(entry.id)) return null;
      const updated = sanitizeEntry({
        ...entry,
        wordCount: countWords(entry.body || ''),
        photoCount: entry.photoUris?.length || 0,
        updatedAt: Date.now(),
      });
      updated.wordCount = countWords(updated.body || '');
      await syncEngine.commitMutation('entry', 'upsert', updated.id, updated);
      const stored = await localRepository.getEntry(updated.id);
      return stored ? (await syncEngine.hydrateEntries([stored]))[0] : null;
    };
    if (property === 'deleteEntry') return async (id: string): Promise<boolean> => {
      if (!await localRepository.getEntry(id)) return false;
      await syncEngine.commitMutation('entry', 'delete', id, null);
      return true;
    };
    if (property === 'createNote') return async (input: NewNote): Promise<Note> => {
      const timestamp = Date.now();
      const note: Note = sanitizeNote({ ...input, id: createId('note'), createdAt: timestamp, updatedAt: timestamp });
      await syncEngine.commitMutation('note', 'upsert', note.id, note);
      return note;
    };
    if (property === 'updateNote') return async (note: Note): Promise<Note | null> => {
      if (!await localRepository.getNote(note.id)) return null;
      const updated = sanitizeNote({ ...note, updatedAt: Date.now() });
      await syncEngine.commitMutation('note', 'upsert', updated.id, updated);
      return localRepository.getNote(updated.id);
    };
    if (property === 'deleteNote') return async (id: string): Promise<boolean> => {
      if (!await localRepository.getNote(id)) return false;
      await syncEngine.commitMutation('note', 'delete', id, null);
      return true;
    };

    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
