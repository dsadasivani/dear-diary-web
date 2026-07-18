import type {
  AppSettings,
  BackupMergePreview,
  BackupMergeResult,
  Diary,
  Mood,
  Note,
} from '../types';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';

export type MergeIdFactory = (kind: 'diary' | 'entry' | 'note', sourceId: string) => string;

export interface PortableMergePlan {
  snapshot: RepositorySnapshot;
  preview: BackupMergePreview;
  result: BackupMergeResult;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const defaultIdFactory: MergeIdFactory = (kind) => `${kind}-${crypto.randomUUID()}`;

const comparableDiary = (diary: Diary): Omit<Diary, 'entryCount' | 'lastUpdated'> => {
  const { entryCount: _entryCount, lastUpdated: _lastUpdated, ...portable } = diary;
  return portable;
};

const equivalent = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const recoveredTitle = (title: string): string =>
  title.endsWith(' (Recovered conflict)') ? title : `${title} (Recovered conflict)`;

const uniqueRecoveredDiaryName = (name: string, diaries: Diary[]): string => {
  const base = `${name} (Recovered from Drive)`;
  const names = new Set(diaries.map((diary) => diary.name.toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLocaleLowerCase())) index += 1;
  return `${base} ${index}`;
};

const mergeCatalogs = (
  local: AppSettings | undefined,
  incoming: AppSettings | undefined,
): { settings: AppSettings | undefined; moodConflicts: number } => {
  if (!local) return { settings: incoming ? clone(incoming) : undefined, moodConflicts: 0 };
  if (!incoming) return { settings: clone(local), moodConflicts: 0 };
  const customTags = [
    ...new Set(
      [...(local.customTags || []), ...(incoming.customTags || [])]
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const customMoods = clone(local.customMoods || []);
  const moodNames = new Map(customMoods.map((mood) => [mood.name.toLocaleLowerCase(), mood]));
  let moodConflicts = 0;
  for (const mood of incoming.customMoods || []) {
    const existing = moodNames.get(mood.name.toLocaleLowerCase());
    if (!existing) {
      customMoods.push(clone(mood));
      moodNames.set(mood.name.toLocaleLowerCase(), mood);
      continue;
    }
    if (existing.emoji === mood.emoji) continue;
    moodConflicts += 1;
    let recoveredName = `${mood.name} (Recovered)`;
    let index = 2;
    while (moodNames.has(recoveredName.toLocaleLowerCase()))
      recoveredName = `${mood.name} (Recovered ${index++})`;
    const recovered: Mood = { ...clone(mood), name: recoveredName };
    customMoods.push(recovered);
    moodNames.set(recoveredName.toLocaleLowerCase(), recovered);
  }
  return {
    settings: { ...clone(local), customTags, customMoods },
    moodConflicts,
  };
};

export const buildPortableMergePlan = (
  local: RepositorySnapshot,
  incoming: RepositorySnapshot,
  mediaCount = 0,
  idFactory: MergeIdFactory = defaultIdFactory,
): PortableMergePlan => {
  const diaries = clone(local.diaries);
  const entries = clone(local.entries);
  const notes = clone(local.notes);
  const add = { diaries: 0, entries: 0, notes: 0 };
  const skip = { diaries: 0, entries: 0, notes: 0 };
  const conflicts = { diaries: 0, entries: 0, notes: 0, moods: 0 };
  const importedDiaryIds: string[] = [];
  const diaryMap = new Map<string, { targetId: string; cloneWholeDiary: boolean }>();

  for (const cloudDiary of incoming.diaries) {
    const localDiary = diaries.find((diary) => diary.id === cloudDiary.id);
    if (!localDiary) {
      diaries.push(clone(cloudDiary));
      diaryMap.set(cloudDiary.id, { targetId: cloudDiary.id, cloneWholeDiary: false });
      importedDiaryIds.push(cloudDiary.id);
      add.diaries += 1;
    } else if (equivalent(comparableDiary(localDiary), comparableDiary(cloudDiary))) {
      diaryMap.set(cloudDiary.id, { targetId: localDiary.id, cloneWholeDiary: false });
      skip.diaries += 1;
    } else {
      const targetId = idFactory('diary', cloudDiary.id);
      diaries.push({
        ...clone(cloudDiary),
        id: targetId,
        name: uniqueRecoveredDiaryName(cloudDiary.name, diaries),
        entryCount: 0,
        lastUpdated: 'No entries yet',
      });
      diaryMap.set(cloudDiary.id, { targetId, cloneWholeDiary: true });
      importedDiaryIds.push(targetId);
      add.diaries += 1;
      conflicts.diaries += 1;
    }
  }

  for (const cloudEntry of incoming.entries) {
    const mapping = diaryMap.get(cloudEntry.diaryId);
    if (!mapping) continue;
    if (mapping.cloneWholeDiary) {
      entries.push({
        ...clone(cloudEntry),
        id: idFactory('entry', cloudEntry.id),
        diaryId: mapping.targetId,
      });
      add.entries += 1;
      continue;
    }
    const localEntry = entries.find((entry) => entry.id === cloudEntry.id);
    if (!localEntry) {
      entries.push({ ...clone(cloudEntry), diaryId: mapping.targetId });
      add.entries += 1;
    } else if (equivalent(localEntry, cloudEntry)) {
      skip.entries += 1;
    } else {
      entries.push({
        ...clone(cloudEntry),
        id: idFactory('entry', cloudEntry.id),
        diaryId: mapping.targetId,
        title: recoveredTitle(cloudEntry.title),
      });
      add.entries += 1;
      conflicts.entries += 1;
    }
  }

  for (const cloudNote of incoming.notes) {
    const localNote = notes.find((note) => note.id === cloudNote.id);
    if (!localNote) {
      notes.push(clone(cloudNote));
      add.notes += 1;
    } else if (equivalent(localNote, cloudNote)) {
      skip.notes += 1;
    } else {
      const recovered: Note = {
        ...clone(cloudNote),
        id: idFactory('note', cloudNote.id),
        title: recoveredTitle(cloudNote.title),
      };
      notes.push(recovered);
      add.notes += 1;
      conflicts.notes += 1;
    }
  }

  const catalogs = mergeCatalogs(local.settings, incoming.settings);
  conflicts.moods = catalogs.moodConflicts;
  const preview: BackupMergePreview = {
    incoming: {
      diaries: incoming.diaries.length,
      entries: incoming.entries.length,
      notes: incoming.notes.length,
      media: mediaCount,
    },
    add,
    skip,
    conflicts,
  };
  return {
    snapshot: {
      ...clone(local),
      diaries,
      entries,
      notes,
      settings: catalogs.settings,
      userProfile: local.userProfile,
      security: local.security,
      driveBackupSettings: local.driveBackupSettings,
    },
    preview,
    result: { ...preview, importedDiaryIds },
  };
};
