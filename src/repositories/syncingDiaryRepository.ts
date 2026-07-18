import type { AppSettings, Diary, Entry, Note, UserProfile } from '../types';
import type { DiaryRepository, NewDiary, NewEntry, NewNote } from './DiaryRepository';
import type { EventSyncEngine } from '../sync/eventSyncEngine';
import { richTextHtmlToPlainText, sanitizeEntry, sanitizeNote } from '../domain/richTextSanitizer';
import { reportUnexpectedError } from '../infrastructure/telemetry/reportUnexpectedError';

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

const requestBackgroundFlush = (syncEngine: EventSyncEngine): void => {
  if (typeof syncEngine.requestOutboxFlush === 'function') {
    syncEngine.requestOutboxFlush();
    return;
  }
  void syncEngine.pullPending().catch((error) => {
    reportUnexpectedError('sync.repository.background_flush', error);
  });
};

const SYNC_OVERRIDE_METHODS = [
  'listDiaries',
  'getDiary',
  'listEntries',
  'getEntry',
  'getUserProfile',
  'saveSettings',
  'saveUserProfile',
  'createDiary',
  'updateDiary',
  'deleteDiary',
  'createEntry',
  'updateEntry',
  'deleteEntry',
  'createNote',
  'updateNote',
  'deleteNote',
] as const satisfies ReadonlyArray<keyof DiaryRepository>;

const createBoundRepositoryDelegate = (target: DiaryRepository): DiaryRepository => {
  const delegate: Record<PropertyKey, unknown> = {};
  let source: object | null = target;
  while (source && source !== Object.prototype) {
    for (const property of Reflect.ownKeys(source)) {
      if (property === 'constructor' || property in delegate) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
      if (!descriptor) continue;
      if (typeof descriptor.value === 'function')
        delegate[property] = descriptor.value.bind(target);
      else if ('value' in descriptor) delegate[property] = descriptor.value;
    }
    source = Reflect.getPrototypeOf(source);
  }
  return delegate as unknown as DiaryRepository;
};

export const createSyncingDiaryRepository = (
  localRepository: DiaryRepository,
  syncEngine: EventSyncEngine,
): DiaryRepository => {
  const resolveOverride = (property: keyof DiaryRepository): unknown => {
    if (property === 'listDiaries')
      return async (): Promise<Diary[]> =>
        syncEngine.hydrateDiaries(await localRepository.listDiaries());
    if (property === 'getDiary')
      return async (id: string): Promise<Diary | null> => {
        const diary = await localRepository.getDiary(id);
        return diary ? syncEngine.hydrateDiary(diary) : null;
      };
    if (property === 'listEntries')
      return async (): Promise<Entry[]> => localRepository.listEntries();
    if (property === 'getEntry')
      return async (id: string): Promise<Entry | null> => {
        const entry = await localRepository.getEntry(id);
        return entry ? (await syncEngine.hydrateEntries([entry]))[0] : null;
      };
    if (property === 'getUserProfile')
      return async (): Promise<UserProfile> =>
        syncEngine.hydrateProfile(await localRepository.getUserProfile());
    if (property === 'saveSettings')
      return async (settings: AppSettings): Promise<void> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) {
          await localRepository.saveSettings(settings);
          return;
        }
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'settings',
          recordId: 'settings',
          operation: 'upsert',
          account,
          localPayload: settings,
          syncPayload: toSyncedSettingsPayload(settings),
        });
        requestBackgroundFlush(syncEngine);
      };
    if (property === 'saveUserProfile')
      return async (profile: UserProfile): Promise<void> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) {
          await localRepository.saveUserProfile(profile);
          return;
        }
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'profile',
          recordId: 'profile',
          operation: 'upsert',
          account,
          localPayload: profile,
        });
        requestBackgroundFlush(syncEngine);
      };
    if (property === 'createDiary')
      return async (input: NewDiary): Promise<Diary> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.createDiary(input);
        const diary: Diary = {
          ...input,
          id: createId('diary'),
          entryCount: 0,
          lastUpdated: 'No entries yet',
          lastEntryUpdatedAt: undefined,
        };
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'diary',
          recordId: diary.id,
          operation: 'upsert',
          account,
          localPayload: diary,
        });
        requestBackgroundFlush(syncEngine);
        return saved as Diary;
      };
    if (property === 'updateDiary')
      return async (diary: Diary): Promise<Diary | null> => {
        if (!(await localRepository.getDiary(diary.id))) return null;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.updateDiary(diary);
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'diary',
          recordId: diary.id,
          operation: 'upsert',
          account,
          localPayload: diary,
        });
        requestBackgroundFlush(syncEngine);
        return saved ? syncEngine.hydrateDiary(saved as Diary) : null;
      };
    if (property === 'deleteDiary')
      return async (id: string): Promise<boolean> => {
        if (!(await localRepository.getDiary(id))) return false;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.deleteDiary(id);
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'diary',
          recordId: id,
          operation: 'delete',
          account,
          localPayload: null,
          syncPayload: null,
        });
        requestBackgroundFlush(syncEngine);
        return true;
      };
    if (property === 'createEntry')
      return async (input: NewEntry): Promise<Entry> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.createEntry(input);
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
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'entry',
          recordId: entry.id,
          operation: 'upsert',
          account,
          localPayload: entry,
        });
        requestBackgroundFlush(syncEngine);
        return saved as Entry;
      };
    if (property === 'updateEntry')
      return async (entry: Entry): Promise<Entry | null> => {
        if (!(await localRepository.getEntry(entry.id))) return null;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.updateEntry(entry);
        const updated = sanitizeEntry({
          ...entry,
          wordCount: countWords(entry.body || ''),
          photoCount: entry.photoUris?.length || 0,
          updatedAt: Date.now(),
        });
        updated.wordCount = countWords(updated.body || '');
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'entry',
          recordId: updated.id,
          operation: 'upsert',
          account,
          localPayload: updated,
        });
        requestBackgroundFlush(syncEngine);
        return saved ? (await syncEngine.hydrateEntries([saved as Entry]))[0] : null;
      };
    if (property === 'deleteEntry')
      return async (id: string): Promise<boolean> => {
        if (!(await localRepository.getEntry(id))) return false;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.deleteEntry(id);
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'entry',
          recordId: id,
          operation: 'delete',
          account,
          localPayload: null,
          syncPayload: null,
        });
        requestBackgroundFlush(syncEngine);
        return true;
      };
    if (property === 'createNote')
      return async (input: NewNote): Promise<Note> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.createNote(input);
        const timestamp = Date.now();
        const note: Note = sanitizeNote({
          ...input,
          id: createId('note'),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'note',
          recordId: note.id,
          operation: 'upsert',
          account,
          localPayload: note,
        });
        requestBackgroundFlush(syncEngine);
        return saved as Note;
      };
    if (property === 'updateNote')
      return async (note: Note): Promise<Note | null> => {
        if (!(await localRepository.getNote(note.id))) return null;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.updateNote(note);
        const updated = sanitizeNote({ ...note, updatedAt: Date.now() });
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'note',
          recordId: updated.id,
          operation: 'upsert',
          account,
          localPayload: updated,
        });
        requestBackgroundFlush(syncEngine);
        return saved as Note;
      };
    if (property === 'deleteNote')
      return async (id: string): Promise<boolean> => {
        if (!(await localRepository.getNote(id))) return false;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.deleteNote(id);
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'note',
          recordId: id,
          operation: 'delete',
          account,
          localPayload: null,
          syncPayload: null,
        });
        requestBackgroundFlush(syncEngine);
        return true;
      };

    return undefined;
  };
  const delegate = createBoundRepositoryDelegate(localRepository);
  const mutableDelegate = delegate as unknown as Record<keyof DiaryRepository, unknown>;
  for (const property of SYNC_OVERRIDE_METHODS)
    mutableDelegate[property] = resolveOverride(property);
  return delegate;
};
