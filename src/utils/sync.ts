import { 
  collection, doc, getDocs, setDoc, deleteDoc, writeBatch, getDoc 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { 
  getDiaries, saveDiaries, 
  getEntries, saveEntries, 
  getNotes, saveNotes, 
  getAppSettings, saveAppSettings, 
  getUserProfile, saveUserProfile 
} from './storage';
import { Diary, Entry, Note, AppSettings, UserProfile } from '../types';

// Perform a full, safe bidirectional sync of all data
export async function syncLocalAndCloud(userId: string): Promise<void> {
  try {
    const batch = writeBatch(db);

    // 1. User Profile Sync
    const profileDocRef = doc(db, 'users', userId);
    const localProfile = getUserProfile();
    let profileSnap;
    try {
      profileSnap = await getDoc(profileDocRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${userId}`);
    }

    if (profileSnap.exists()) {
      const remoteProfile = profileSnap.data() as UserProfile;
      const mergedProfile = { ...localProfile, ...remoteProfile };
      saveUserProfile(mergedProfile);
      batch.set(profileDocRef, mergedProfile);
    } else {
      batch.set(profileDocRef, localProfile);
    }

    // 2. App Settings Sync
    const settingsDocRef = doc(db, 'users', userId, 'settings', 'app');
    const localSettings = getAppSettings();
    let settingsSnap;
    try {
      settingsSnap = await getDoc(settingsDocRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${userId}/settings/app`);
    }

    if (settingsSnap.exists()) {
      const remoteSettings = settingsSnap.data() as AppSettings;
      const mergedSettings = { ...localSettings, ...remoteSettings };
      saveAppSettings(mergedSettings);
      batch.set(settingsDocRef, mergedSettings);
    } else {
      batch.set(settingsDocRef, localSettings);
    }

    // 3. Diaries Sync
    const diariesColRef = collection(db, 'users', userId, 'diaries');
    let diariesSnap;
    try {
      diariesSnap = await getDocs(diariesColRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `users/${userId}/diaries`);
    }

    const remoteDiariesMap = new Map<string, Diary>();
    diariesSnap.forEach(docSnap => {
      remoteDiariesMap.set(docSnap.id, docSnap.data() as Diary);
    });

    const localDiaries = getDiaries();
    const mergedDiaries: Diary[] = [];
    const diariesToUpload: Diary[] = [];

    for (const localDiary of localDiaries) {
      const remoteDiary = remoteDiariesMap.get(localDiary.id);
      if (remoteDiary) {
        const merged = { ...remoteDiary, ...localDiary };
        mergedDiaries.push(merged);
        diariesToUpload.push(merged);
        remoteDiariesMap.delete(localDiary.id);
      } else {
        mergedDiaries.push(localDiary);
        diariesToUpload.push(localDiary);
      }
    }

    for (const remoteDiary of remoteDiariesMap.values()) {
      mergedDiaries.push(remoteDiary);
    }

    saveDiaries(mergedDiaries);
    for (const diary of diariesToUpload) {
      const ref = doc(db, 'users', userId, 'diaries', diary.id);
      batch.set(ref, diary);
    }

    // 4. Entries Sync
    const entriesColRef = collection(db, 'users', userId, 'entries');
    let entriesSnap;
    try {
      entriesSnap = await getDocs(entriesColRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `users/${userId}/entries`);
    }

    const remoteEntriesMap = new Map<string, Entry>();
    entriesSnap.forEach(docSnap => {
      remoteEntriesMap.set(docSnap.id, docSnap.data() as Entry);
    });

    const localEntries = getEntries();
    const mergedEntries: Entry[] = [];
    const entriesToUpload: Entry[] = [];

    for (const localEntry of localEntries) {
      const remoteEntry = remoteEntriesMap.get(localEntry.id);
      if (remoteEntry) {
        const localTime = localEntry.updatedAt || localEntry.createdAt || 0;
        const remoteTime = remoteEntry.updatedAt || remoteEntry.createdAt || 0;
        if (localTime >= remoteTime) {
          mergedEntries.push(localEntry);
          entriesToUpload.push(localEntry);
        } else {
          mergedEntries.push(remoteEntry);
        }
        remoteEntriesMap.delete(localEntry.id);
      } else {
        mergedEntries.push(localEntry);
        entriesToUpload.push(localEntry);
      }
    }

    for (const remoteEntry of remoteEntriesMap.values()) {
      mergedEntries.push(remoteEntry);
    }

    saveEntries(mergedEntries);
    for (const entry of entriesToUpload) {
      const ref = doc(db, 'users', userId, 'entries', entry.id);
      batch.set(ref, entry);
    }

    // 5. Notes Sync
    const notesColRef = collection(db, 'users', userId, 'notes');
    let notesSnap;
    try {
      notesSnap = await getDocs(notesColRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `users/${userId}/notes`);
    }

    const remoteNotesMap = new Map<string, Note>();
    notesSnap.forEach(docSnap => {
      remoteNotesMap.set(docSnap.id, docSnap.data() as Note);
    });

    const localNotes = getNotes();
    const mergedNotes: Note[] = [];
    const notesToUpload: Note[] = [];

    for (const localNote of localNotes) {
      const remoteNote = remoteNotesMap.get(localNote.id);
      if (remoteNote) {
        const localTime = localNote.updatedAt || localNote.createdAt || 0;
        const remoteTime = remoteNote.updatedAt || remoteNote.createdAt || 0;
        if (localTime >= remoteTime) {
          mergedNotes.push(localNote);
          notesToUpload.push(localNote);
        } else {
          mergedNotes.push(remoteNote);
        }
        remoteNotesMap.delete(localNote.id);
      } else {
        mergedNotes.push(localNote);
        notesToUpload.push(localNote);
      }
    }

    for (const remoteNote of remoteNotesMap.values()) {
      mergedNotes.push(remoteNote);
    }

    saveNotes(mergedNotes);
    for (const note of notesToUpload) {
      const ref = doc(db, 'users', userId, 'notes', note.id);
      batch.set(ref, note);
    }

    // Commit all pending sync updates to cloud
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${userId}/[batch_commit]`);
    }
  } catch (error) {
    console.error('Error during bidirectional sync:', error);
    throw error;
  }
}

// Single item Firestore persistence helpers (for immediate writes when online)
export async function saveProfileToCloud(userId: string, profile: UserProfile): Promise<void> {
  try {
    await setDoc(doc(db, 'users', userId), profile);
  } catch (error) {
    console.warn('Could not save profile to cloud:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}`);
  }
}

export async function saveSettingsToCloud(userId: string, settings: AppSettings): Promise<void> {
  try {
    await setDoc(doc(db, 'users', userId, 'settings', 'app'), settings);
  } catch (error) {
    console.warn('Could not save settings to cloud:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/settings/app`);
  }
}

export async function saveDiaryToCloud(userId: string, diary: Diary): Promise<void> {
  try {
    await setDoc(doc(db, 'users', userId, 'diaries', diary.id), diary);
  } catch (error) {
    console.warn('Could not save diary to cloud:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/diaries/${diary.id}`);
  }
}

export async function deleteDiaryFromCloud(userId: string, diaryId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'users', userId, 'diaries', diaryId));
  } catch (error) {
    console.warn('Could not delete diary from cloud:', error);
    handleFirestoreError(error, OperationType.DELETE, `users/${userId}/diaries/${diaryId}`);
  }
}

export async function saveEntryToCloud(userId: string, entry: Entry): Promise<void> {
  try {
    await setDoc(doc(db, 'users', userId, 'entries', entry.id), entry);
  } catch (error) {
    console.warn('Could not save entry to cloud:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/entries/${entry.id}`);
  }
}

export async function deleteEntryFromCloud(userId: string, entryId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'users', userId, 'entries', entryId));
  } catch (error) {
    console.warn('Could not delete entry from cloud:', error);
    handleFirestoreError(error, OperationType.DELETE, `users/${userId}/entries/${entryId}`);
  }
}

export async function saveNoteToCloud(userId: string, note: Note): Promise<void> {
  try {
    await setDoc(doc(db, 'users', userId, 'notes', note.id), note);
  } catch (error) {
    console.warn('Could not save note to cloud:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/notes/${note.id}`);
  }
}

export async function deleteNoteFromCloud(userId: string, noteId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'users', userId, 'notes', noteId));
  } catch (error) {
    console.warn('Could not delete note from cloud:', error);
    handleFirestoreError(error, OperationType.DELETE, `users/${userId}/notes/${noteId}`);
  }
}

// Check if any diaries, entries, or notes exist in the cloud for this user
export async function checkCloudDataExists(userId: string): Promise<boolean> {
  try {
    const diariesColRef = collection(db, 'users', userId, 'diaries');
    const diariesSnap = await getDocs(diariesColRef);
    if (!diariesSnap.empty) return true;

    const entriesColRef = collection(db, 'users', userId, 'entries');
    const entriesSnap = await getDocs(entriesColRef);
    if (!entriesSnap.empty) return true;

    const notesColRef = collection(db, 'users', userId, 'notes');
    const notesSnap = await getDocs(notesColRef);
    if (!notesSnap.empty) return true;

    return false;
  } catch (error) {
    console.error('Error checking cloud data:', error);
    return false;
  }
}

// Delete all diaries, entries, and notes in the cloud
export async function wipeCloudData(userId: string): Promise<void> {
  try {
    const batch = writeBatch(db);

    const diariesColRef = collection(db, 'users', userId, 'diaries');
    const diariesSnap = await getDocs(diariesColRef);
    diariesSnap.forEach(docSnap => {
      batch.delete(docSnap.ref);
    });

    const entriesColRef = collection(db, 'users', userId, 'entries');
    const entriesSnap = await getDocs(entriesColRef);
    entriesSnap.forEach(docSnap => {
      batch.delete(docSnap.ref);
    });

    const notesColRef = collection(db, 'users', userId, 'notes');
    const notesSnap = await getDocs(notesColRef);
    notesSnap.forEach(docSnap => {
      batch.delete(docSnap.ref);
    });

    await batch.commit();
  } catch (error) {
    console.error('Error during wipeCloudData:', error);
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/[wipe_cloud_data]`);
  }
}

// Download all diaries, entries, and notes from cloud to overwrite local storage
export async function restoreFromCloud(userId: string): Promise<void> {
  try {
    // Restore profile and settings
    const profileDocRef = doc(db, 'users', userId);
    const profileSnap = await getDoc(profileDocRef);
    if (profileSnap.exists()) {
      saveUserProfile(profileSnap.data() as UserProfile);
    }

    const settingsDocRef = doc(db, 'users', userId, 'settings', 'app');
    const settingsSnap = await getDoc(settingsDocRef);
    if (settingsSnap.exists()) {
      saveAppSettings(settingsSnap.data() as AppSettings);
    }

    // Restore diaries
    const diariesColRef = collection(db, 'users', userId, 'diaries');
    const diariesSnap = await getDocs(diariesColRef);
    const diaries: Diary[] = [];
    diariesSnap.forEach(docSnap => {
      diaries.push(docSnap.data() as Diary);
    });
    if (diaries.length > 0) {
      saveDiaries(diaries);
    }

    // Restore entries
    const entriesColRef = collection(db, 'users', userId, 'entries');
    const entriesSnap = await getDocs(entriesColRef);
    const entries: Entry[] = [];
    entriesSnap.forEach(docSnap => {
      entries.push(docSnap.data() as Entry);
    });
    saveEntries(entries);

    // Restore notes
    const notesColRef = collection(db, 'users', userId, 'notes');
    const notesSnap = await getDocs(notesColRef);
    const notes: Note[] = [];
    notesSnap.forEach(docSnap => {
      notes.push(docSnap.data() as Note);
    });
    saveNotes(notes);
  } catch (error) {
    console.error('Error during restoreFromCloud:', error);
    handleFirestoreError(error, OperationType.LIST, `users/${userId}/[restore_from_cloud]`);
  }
}

export interface SyncComparison {
  localCount: { diaries: number; entries: number; notes: number };
  cloudCount: { diaries: number; entries: number; notes: number };
  hasCloudUpdates: boolean;
  hasLocalUpdates: boolean;
  isMismatch: boolean;
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const normalizeDiaryForComparison = (diary: Diary): Partial<Diary> => {
  const { entryCount, lastUpdated, ...rest } = diary;
  return rest;
};

const normalizeEntryForComparison = (entry: Entry): Partial<Entry> => {
  const { createdAt, updatedAt, wordCount, photoCount, ...rest } = entry;
  return rest;
};

const normalizeNoteForComparison = (note: Note): Partial<Note> => {
  const { createdAt, updatedAt, ...rest } = note;
  return rest;
};

// Compares local and cloud databases to identify mismatches and sync conflicts
export async function getSyncComparison(userId: string): Promise<SyncComparison> {
  const localDiaries = getDiaries();
  const localEntries = getEntries();
  const localNotes = getNotes();

  // Fetch cloud data
  const diariesColRef = collection(db, 'users', userId, 'diaries');
  const diariesSnap = await getDocs(diariesColRef);
  const cloudDiaries: Diary[] = [];
  diariesSnap.forEach(snap => cloudDiaries.push(snap.data() as Diary));

  const entriesColRef = collection(db, 'users', userId, 'entries');
  const entriesSnap = await getDocs(entriesColRef);
  const cloudEntries: Entry[] = [];
  entriesSnap.forEach(snap => cloudEntries.push(snap.data() as Entry));

  const notesColRef = collection(db, 'users', userId, 'notes');
  const notesSnap = await getDocs(notesColRef);
  const cloudNotes: Note[] = [];
  notesSnap.forEach(snap => cloudNotes.push(snap.data() as Note));

  // Compare diaries
  const localDiariesMap = new Map(localDiaries.map(d => [d.id, d]));
  const cloudDiariesMap = new Map(cloudDiaries.map(d => [d.id, d]));
  
  let hasCloudUpdates = false;
  let hasLocalUpdates = false;

  for (const localDiary of localDiaries) {
    const cloudDiary = cloudDiariesMap.get(localDiary.id);
    if (!cloudDiary) {
      hasLocalUpdates = true;
    } else if (stableStringify(normalizeDiaryForComparison(localDiary)) !== stableStringify(normalizeDiaryForComparison(cloudDiary))) {
      hasLocalUpdates = true;
      hasCloudUpdates = true; // Mark as both updated for bidirectional merging
    }
  }
  for (const cloudDiary of cloudDiaries) {
    if (!localDiariesMap.has(cloudDiary.id)) {
      hasCloudUpdates = true;
    }
  }

  // Compare entries
  const localEntriesMap = new Map(localEntries.map(e => [e.id, e]));
  const cloudEntriesMap = new Map(cloudEntries.map(e => [e.id, e]));

  for (const localEntry of localEntries) {
    const cloudEntry = cloudEntriesMap.get(localEntry.id);
    if (!cloudEntry) {
      hasLocalUpdates = true;
    } else {
      const localContent = stableStringify(normalizeEntryForComparison(localEntry));
      const cloudContent = stableStringify(normalizeEntryForComparison(cloudEntry));
      if (localContent !== cloudContent) {
        const localTime = localEntry.updatedAt || localEntry.createdAt || 0;
        const remoteTime = cloudEntry.updatedAt || cloudEntry.createdAt || 0;
        if (localTime > remoteTime) {
          hasLocalUpdates = true;
        } else if (remoteTime > localTime) {
          hasCloudUpdates = true;
        } else {
          hasLocalUpdates = true;
          hasCloudUpdates = true;
        }
      }
    }
  }
  for (const cloudEntry of cloudEntries) {
    if (!localEntriesMap.has(cloudEntry.id)) {
      hasCloudUpdates = true;
    }
  }

  // Compare notes
  const localNotesMap = new Map(localNotes.map(n => [n.id, n]));
  const cloudNotesMap = new Map(cloudNotes.map(n => [n.id, n]));

  for (const localNote of localNotes) {
    const cloudNote = cloudNotesMap.get(localNote.id);
    if (!cloudNote) {
      hasLocalUpdates = true;
    } else {
      const localContent = stableStringify(normalizeNoteForComparison(localNote));
      const cloudContent = stableStringify(normalizeNoteForComparison(cloudNote));
      if (localContent !== cloudContent) {
        const localTime = localNote.updatedAt || localNote.createdAt || 0;
        const remoteTime = cloudNote.updatedAt || cloudNote.createdAt || 0;
        if (localTime > remoteTime) {
          hasLocalUpdates = true;
        } else if (remoteTime > localTime) {
          hasCloudUpdates = true;
        } else {
          hasLocalUpdates = true;
          hasCloudUpdates = true;
        }
      }
    }
  }
  for (const cloudNote of cloudNotes) {
    if (!localNotesMap.has(cloudNote.id)) {
      hasCloudUpdates = true;
    }
  }

  const isMismatch = hasCloudUpdates || hasLocalUpdates ||
    localDiaries.length !== cloudDiaries.length ||
    localEntries.length !== cloudEntries.length ||
    localNotes.length !== cloudNotes.length;

  return {
    localCount: { diaries: localDiaries.length, entries: localEntries.length, notes: localNotes.length },
    cloudCount: { diaries: cloudDiaries.length, entries: cloudEntries.length, notes: cloudNotes.length },
    hasCloudUpdates,
    hasLocalUpdates,
    isMismatch
  };
}

