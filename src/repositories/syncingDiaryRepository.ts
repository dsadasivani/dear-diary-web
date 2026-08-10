import type { AppSettings, Diary, Entry, Note, UserProfile } from '../types';
import type { DiaryRepository, NewDiary, NewEntry, NewNote } from './DiaryRepository';
import type { EventSyncEngine } from '../sync/eventSyncEngine';
import { richTextHtmlToPlainText, sanitizeEntry, sanitizeNote } from '../domain/richTextSanitizer';
import { reportUnexpectedError } from '../infrastructure/telemetry/reportUnexpectedError';
import { toPortableDiary, toPortableEntry, toPortableUserProfile } from '../sync/portableMedia';
import { recordPositiveDailyWordDelta } from '../domain/journalCatalog';

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

const normalizedSyncPayload = (value: unknown): string => {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(
          ([key]) =>
            ![
              'updatedAt',
              'createdAt',
              'wordCount',
              'photoCount',
              'wordsWrittenByDate',
              'entryCount',
              'lastUpdated',
              'lastEntryUpdatedAt',
            ].includes(key),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return JSON.stringify(normalize(value));
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
  'publishPendingEntryDraft',
  'createNote',
  'updateNote',
  'deleteNote',
  'resetContent',
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
  const publicationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const firstPendingEditAt = new Map<string, number>();
  const scheduleEntryPublication = (entryId: string): void => {
    const now = Date.now();
    const firstEditAt = firstPendingEditAt.get(entryId) || now;
    firstPendingEditAt.set(entryId, firstEditAt);
    const delayMs = Math.max(0, Math.min(15_000, firstEditAt + 60_000 - now));
    const existing = publicationTimers.get(entryId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      publicationTimers.delete(entryId);
      firstPendingEditAt.delete(entryId);
      void localRepository
        .publishPendingEntryDraft(entryId)
        .then(() => requestBackgroundFlush(syncEngine))
        .catch((error) => reportUnexpectedError('sync.repository.publish_entry_draft', error));
    }, delayMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    publicationTimers.set(entryId, timer);
  };
  const publishEntryNow = async (entryId: string): Promise<void> => {
    const existing = publicationTimers.get(entryId);
    if (existing) clearTimeout(existing);
    publicationTimers.delete(entryId);
    firstPendingEditAt.delete(entryId);
    await localRepository.publishPendingEntryDraft(entryId);
    requestBackgroundFlush(syncEngine);
  };
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
          syncPayload: toPortableUserProfile(profile),
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
          syncPayload: toPortableDiary(diary),
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
          syncPayload: toPortableDiary(diary),
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
          wordsWrittenByDate: recordPositiveDailyWordDelta(
            null,
            countWords(input.body || ''),
            timestamp,
          ),
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
          syncPayload: toPortableEntry(entry),
          publishNotBefore: Date.now() + 15_000,
        });
        scheduleEntryPublication(entry.id);
        return saved as Entry;
      };
    if (property === 'updateEntry')
      return async (entry: Entry): Promise<Entry | null> => {
        const previous = await localRepository.getEntry(entry.id);
        if (!previous) return null;
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) return localRepository.updateEntry(entry);
        if (
          normalizedSyncPayload(toPortableEntry(previous)) ===
          normalizedSyncPayload(toPortableEntry(entry))
        ) {
          return (await syncEngine.hydrateEntries([previous]))[0];
        }
        const nextWordCount = countWords(entry.body || '');
        const updatedAt = Date.now();
        const updated = sanitizeEntry({
          ...entry,
          wordCount: nextWordCount,
          wordsWrittenByDate: recordPositiveDailyWordDelta(previous, nextWordCount, updatedAt),
          photoCount: entry.photoUris?.length || 0,
          updatedAt,
        });
        updated.wordCount = countWords(updated.body || '');
        const saved = await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'entry',
          recordId: updated.id,
          operation: 'upsert',
          account,
          localPayload: updated,
          syncPayload: toPortableEntry(updated),
          publishNotBefore: Date.now() + 15_000,
        });
        scheduleEntryPublication(updated.id);
        return saved ? (await syncEngine.hydrateEntries([saved as Entry]))[0] : null;
      };
    if (property === 'deleteEntry')
      return async (id: string): Promise<boolean> => {
        const publicationTimer = publicationTimers.get(id);
        if (publicationTimer) clearTimeout(publicationTimer);
        publicationTimers.delete(id);
        firstPendingEditAt.delete(id);
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
    if (property === 'publishPendingEntryDraft')
      return (entryId: string): Promise<void> => publishEntryNow(entryId);
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
    if (property === 'resetContent')
      return async (): Promise<void> => {
        const account = await localRepository.getLocalSyncAccountState();
        if (!account) {
          await localRepository.resetContent();
          return;
        }

        // An account-wide reset must start from the newest known record set so
        // records that were created on another device are tombstoned too.
        await syncEngine.pullPending();

        const [diaries, entries, notes, versions] = await Promise.all([
          localRepository.listDiaries(),
          localRepository.listEntries(),
          localRepository.listNotes(),
          localRepository.listSyncRecordVersions(),
        ]);
        const ids = {
          diary: new Set(diaries.map((diary) => diary.id)),
          entry: new Set(entries.map((entry) => entry.id)),
          note: new Set(notes.map((note) => note.id)),
        };
        for (const recordKey of Object.keys(versions)) {
          const separator = recordKey.indexOf(':');
          if (separator <= 0) continue;
          const recordType = recordKey.slice(0, separator);
          const recordId = recordKey.slice(separator + 1);
          if (
            recordId &&
            (recordType === 'diary' || recordType === 'entry' || recordType === 'note')
          ) {
            ids[recordType].add(recordId);
          }
        }

        const enqueueDelete = (recordType: 'diary' | 'entry' | 'note', recordId: string) =>
          localRepository.applyLocalMutationWithOutbox({
            operationId: crypto.randomUUID(),
            recordType,
            recordId,
            operation: 'delete',
            account,
            localPayload: null,
            syncPayload: null,
          });

        // Tombstone entries individually before their journals. This advances
        // the authoritative server version for every entry and prevents a
        // stale offline edit from resurrecting it after the reset.
        for (const entryId of ids.entry) await enqueueDelete('entry', entryId);
        for (const noteId of ids.note) await enqueueDelete('note', noteId);
        for (const diaryId of ids.diary) await enqueueDelete('diary', diaryId);

        const blankDiary: Diary = {
          id: createId('diary'),
          name: 'My Diary',
          emoji: '\uD83D\uDCD4',
          color: '#8A3D55',
          isLocked: false,
          entryCount: 0,
          lastUpdated: 'No entries yet',
          lastEntryUpdatedAt: undefined,
        };
        await localRepository.applyLocalMutationWithOutbox({
          operationId: crypto.randomUUID(),
          recordType: 'diary',
          recordId: blankDiary.id,
          operation: 'upsert',
          account,
          localPayload: blankDiary,
        });
        requestBackgroundFlush(syncEngine);
      };

    return undefined;
  };
  const delegate = createBoundRepositoryDelegate(localRepository);
  const mutableDelegate = delegate as unknown as Record<keyof DiaryRepository, unknown>;
  for (const property of SYNC_OVERRIDE_METHODS)
    mutableDelegate[property] = resolveOverride(property);
  return delegate;
};
