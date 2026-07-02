import CryptoJS from 'crypto-js';
import { Diary, Entry, Note, SecurityConfig, AppSettings, DiaryBackupData, Mood, UserProfile } from '../types';
import { auth, db } from './firebase';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { persistNativeLocalStorageItem } from '../mobile/nativeStorageBridge';
import { syncReminderNotification } from '../mobile/reminders';

const setStorageItem = (key: string, value: string): void => {
  window.localStorage.setItem(key, value);
  persistNativeLocalStorageItem(key, value);
};

// Predefined Moods and Tags
export const PREDEFINED_MOODS = [
  { name: 'Joyful', emoji: '😊' },
  { name: 'Calm', emoji: '😌' },
  { name: 'Sad', emoji: '😢' },
  { name: 'Anxious', emoji: '😟' },
  { name: 'Family', emoji: '🏠' }
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
  'thoughts'
];

export const PREDEFINED_COLORS = [
  { name: 'Velvet Fig', hex: '#8A3D55', bgClass: 'bg-brand-pink', borderClass: 'border-brand-pink' },
  { name: 'Royal Sage', hex: '#4C6A58', bgClass: 'bg-brand-sage', borderClass: 'border-brand-sage' },
  { name: 'Terracotta', hex: '#B85C4B', bgClass: 'bg-brand-rose', borderClass: 'border-brand-rose' },
  { name: 'Warm Sand', hex: '#F3EFE9', bgClass: 'bg-brand-blush-light', borderClass: 'border-brand-border' },
  { name: 'Rich Amber', hex: '#D49B4E', bgClass: 'bg-[#D49B4E]', borderClass: 'border-[#C1883F]' },
  { name: 'Slate Lavender', hex: '#6C7598', bgClass: 'bg-[#6C7598]', borderClass: 'border-[#5A6384]' }
];

// Seed images
const DotomboriImg = "https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=600&auto=format&fit=crop&q=60";
const OkonomiyakiImg = "https://images.unsplash.com/photo-1590401830605-bf0f1e82845c?w=600&auto=format&fit=crop&q=60";
const TeaJournalImg = "https://images.unsplash.com/photo-1517842645767-c639042777db?w=600&auto=format&fit=crop&q=60";
const RainWindowImg = "https://images.unsplash.com/photo-1437419764001-2399a24d81b2?w=600&auto=format&fit=crop&q=60";
const StonesImg = "https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600&auto=format&fit=crop&q=60";
const CatImg = "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=600&auto=format&fit=crop&q=60";

// Standard initial state values
const INITIAL_DIARIES: Diary[] = [
  {
    id: 'diary-default',
    name: 'My Diary',
    emoji: '📔',
    color: '#8A3D55', // Velvet Fig cover default
    isLocked: false,
    entryCount: 0,
    lastUpdated: 'No entries yet'
  }
];

// Helper to get formatted date relative to today
const getRelativeDateString = (daysOffset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - daysOffset);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
};

const INITIAL_ENTRIES: Entry[] = [];

const INITIAL_NOTES: Note[] = [];

// Key constants for localStorage
const STORAGE_KEYS = {
  DIARIES: 'deardiary_diaries',
  ENTRIES: 'deardiary_entries',
  NOTES: 'deardiary_notes',
  SECURITY: 'deardiary_security',
  SETTINGS: 'deardiary_settings',
  USER_PROFILE: 'deardiary_userprofile'
};

// State initializers
export const initializeDatabase = () => {
  if (!localStorage.getItem(STORAGE_KEYS.DIARIES)) {
    setStorageItem(STORAGE_KEYS.DIARIES, JSON.stringify(INITIAL_DIARIES));
  }
  if (!localStorage.getItem(STORAGE_KEYS.ENTRIES)) {
    setStorageItem(STORAGE_KEYS.ENTRIES, JSON.stringify(INITIAL_ENTRIES));
  }
  if (!localStorage.getItem(STORAGE_KEYS.NOTES)) {
    setStorageItem(STORAGE_KEYS.NOTES, JSON.stringify(INITIAL_NOTES));
  }
  if (!localStorage.getItem(STORAGE_KEYS.SECURITY)) {
    const defaultSecurity: SecurityConfig = {
      isPinCreated: false,
      pinHash: '',
      pinSalt: '',
      isBiometricsEnabled: false,
      isLocked: true // Start locked by default
    };
    setStorageItem(STORAGE_KEYS.SECURITY, JSON.stringify(defaultSecurity));
  }
  if (!localStorage.getItem(STORAGE_KEYS.SETTINGS)) {
    const defaultSettings: AppSettings = {
      remindersEnabled: false,
      reminderTime: '08:00 PM',
      theme: 'light',
      autoSyncOnLaunch: true,
      syncOnEntryCreation: true
    };
    setStorageItem(STORAGE_KEYS.SETTINGS, JSON.stringify(defaultSettings));
  }
  if (!localStorage.getItem(STORAGE_KEYS.USER_PROFILE)) {
    const currentUser = auth.currentUser;
    const userEmail = currentUser?.email || 'dili.cherry77@gmail.com';
    let defaultName = 'Journalist';
    if (currentUser?.displayName) {
      defaultName = currentUser.displayName;
    } else if (userEmail) {
      const part = userEmail.split('@')[0];
      defaultName = part.split(/[._-]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
    const defaultProfile: UserProfile = {
      name: defaultName,
      email: userEmail,
      bio: 'Savoring the simple, quiet moments of life.',
      avatarEmoji: '🌸',
      avatarColor: '#8A3D55', // Velvet Fig
      writingGoal: 100,
      joinedDate: 'June 2026'
    };
    setStorageItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(defaultProfile));
  }
};

// User Profile Operations
export const getUserProfile = (): UserProfile => {
  initializeDatabase();
  const profileStr = localStorage.getItem(STORAGE_KEYS.USER_PROFILE);
  const currentUser = auth.currentUser;
  
  let profile: UserProfile | null = null;
  if (profileStr) {
    try {
      profile = JSON.parse(profileStr);
    } catch (e) {
      console.error('Error parsing user profile, reverting to default:', e);
    }
  }

  const userEmail = currentUser?.email || 'dili.cherry77@gmail.com';
  let defaultName = 'Journalist';
  if (currentUser?.displayName) {
    defaultName = currentUser.displayName;
  } else if (userEmail) {
    const part = userEmail.split('@')[0];
    defaultName = part.split(/[._-]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  if (!profile) {
    profile = {
      name: defaultName,
      email: userEmail,
      bio: 'Savoring the simple, quiet moments of life.',
      avatarEmoji: '🌸',
      avatarColor: '#8A3D55',
      writingGoal: 100,
      joinedDate: 'June 2026'
    };
    setStorageItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
  } else {
    // If profile is still using 'Sophie' (the hardcoded default) and there's a logged in user with a different email,
    // or if the name is 'Sophie' or 'Journalist' and we can derive a more specific default name, let's update it!
    let updated = false;
    if (profile.name === 'Sophie') {
      profile.name = defaultName;
      updated = true;
    }
    if (profile.email === 'dili.cherry77@gmail.com' && currentUser?.email && currentUser.email !== 'dili.cherry77@gmail.com') {
      profile.email = currentUser.email;
      updated = true;
    }
    if (updated) {
      setStorageItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
    }
  }

  return profile;
};

export const saveUserProfile = (profile: UserProfile) => {
  setStorageItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(profile));
  try {
    const user = auth.currentUser;
    if (user) {
      setDoc(doc(db, 'users', user.uid), profile).catch(e => console.warn('Cloud sync profile failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
};

// Helper to calculate total words written today
export const getTodayWordCount = (entries: Entry[]): number => {
  // Format local date relative helper
  const getLocalDateString = (d: Date) => {
    return d.getFullYear() + '-' + 
      String(d.getMonth() + 1).padStart(2, '0') + '-' + 
      String(d.getDate()).padStart(2, '0');
  };
  const todayStr = getLocalDateString(new Date());
  return entries
    .filter(e => e.date === todayStr)
    .reduce((sum, e) => sum + (e.wordCount || 0), 0);
};

// Security Store operations
export const getSecurityConfig = (): SecurityConfig => {
  initializeDatabase();
  const config = JSON.parse(localStorage.getItem(STORAGE_KEYS.SECURITY) || '{}');
  const defaults: SecurityConfig = {
    isPinCreated: false,
    pinHash: '',
    pinSalt: '',
    isBiometricsEnabled: false, // Disabled by default
    isLocked: false
  };
  return { ...defaults, ...config };
};

export const saveSecurityConfig = (config: SecurityConfig) => {
  setStorageItem(STORAGE_KEYS.SECURITY, JSON.stringify(config));
};

export const setPinCode = (pin: string): SecurityConfig => {
  const salt = CryptoJS.lib.WordArray.random(16).toString();
  const pinHash = CryptoJS.SHA256(pin + salt).toString();
  
  const config: SecurityConfig = {
    isPinCreated: true,
    pinHash,
    pinSalt: salt,
    isBiometricsEnabled: false, // Default to disabled, user can enable it in Settings
    isLocked: false // unlock on creation
  };
  
  saveSecurityConfig(config);
  return config;
};

export const resetPinCode = (): SecurityConfig => {
  const config = getSecurityConfig();
  const newConfig: SecurityConfig = {
    ...config,
    isPinCreated: false,
    pinHash: '',
    pinSalt: '',
    isBiometricsEnabled: false, // Reset biometrics too for security
    isLocked: false
  };
  saveSecurityConfig(newConfig);
  return newConfig;
};

export const verifyPinCode = (pin: string): boolean => {
  const config = getSecurityConfig();
  if (!config.isPinCreated) return false;
  
  const computedHash = CryptoJS.SHA256(pin + config.pinSalt).toString();
  if (computedHash === config.pinHash) {
    config.isLocked = false;
    saveSecurityConfig(config);
    return true;
  }
  return false;
};

export const getTags = (): string[] => {
  const settings = getAppSettings();
  const customTags = settings.customTags || [];
  return [...new Set([...PREDEFINED_TAGS, ...customTags])];
};

export const getMoods = (): Mood[] => {
  const settings = getAppSettings();
  const customMoods = settings.customMoods || [];
  const existingNames = new Set(PREDEFINED_MOODS.map(m => m.name));
  const newMoods = customMoods.filter(m => !existingNames.has(m.name));
  return [...PREDEFINED_MOODS, ...newMoods];
};

// App general settings
export const getAppSettings = (): AppSettings => {
  initializeDatabase();
  const settings: AppSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || '{}');
  if (!settings.theme) {
    settings.theme = 'light';
  }
  if (settings.autoSyncOnLaunch === undefined) {
    settings.autoSyncOnLaunch = true;
  }
  if (settings.syncOnEntryCreation === undefined) {
    settings.syncOnEntryCreation = true;
  }
  return settings;
};

export const saveAppSettings = (settings: AppSettings) => {
  setStorageItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  void syncReminderNotification(settings);
  try {
    const user = auth.currentUser;
    if (user) {
      setDoc(doc(db, 'users', user.uid, 'settings', 'app'), settings).catch(e => console.warn('Cloud sync settings failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
};

// Diary CRUD
export const getDiaries = (): Diary[] => {
  initializeDatabase();
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.DIARIES) || '[]');
};

export const saveDiaries = (diaries: Diary[]) => {
  setStorageItem(STORAGE_KEYS.DIARIES, JSON.stringify(diaries));
};

export const createDiary = (name: string, emoji: string, color: string, isLocked: boolean, coverImage?: string, foilIcons?: string[]): Diary => {
  const diaries = getDiaries();
  const newDiary: Diary = {
    id: `diary-${Date.now()}`,
    name: name || 'New Diary',
    emoji: emoji || '📔',
    color: color || '#8A3D55', // Velvet Fig cover by default
    isLocked,
    entryCount: 0,
    lastUpdated: 'Just now',
    coverImage,
    foilIcons
  };
  diaries.push(newDiary);
  saveDiaries(diaries);
  try {
    const user = auth.currentUser;
    if (user) {
      setDoc(doc(db, 'users', user.uid, 'diaries', newDiary.id), newDiary).catch(e => console.warn('Cloud sync createDiary failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
  return newDiary;
};

export const updateDiary = (updatedDiary: Diary): Diary[] => {
  const diaries = getDiaries();
  const index = diaries.findIndex(d => d.id === updatedDiary.id);
  if (index !== -1) {
    diaries[index] = updatedDiary;
    saveDiaries(diaries);
    try {
      const user = auth.currentUser;
      if (user) {
        setDoc(doc(db, 'users', user.uid, 'diaries', updatedDiary.id), updatedDiary).catch(e => console.warn('Cloud sync updateDiary failed:', e));
      }
    } catch (err) {
      console.warn(err);
    }
  }
  return diaries;
};

export const deleteDiary = (diaryId: string) => {
  let diaries = getDiaries();
  diaries = diaries.filter(d => d.id !== diaryId);
  saveDiaries(diaries);

  // Cascade delete entries
  let allEntries = getEntries();
  const entriesToDelete = allEntries.filter(e => e.diaryId === diaryId);
  let entries = allEntries.filter(e => e.diaryId !== diaryId);
  saveEntries(entries);

  try {
    const user = auth.currentUser;
    if (user) {
      deleteDoc(doc(db, 'users', user.uid, 'diaries', diaryId)).catch(e => console.warn('Cloud deleteDiary failed:', e));
      for (const entry of entriesToDelete) {
        deleteDoc(doc(db, 'users', user.uid, 'entries', entry.id)).catch(e => console.warn('Cloud deleteEntry failed:', e));
      }
    }
  } catch (err) {
    console.warn(err);
  }
};

// Entry CRUD
export const getEntries = (): Entry[] => {
  initializeDatabase();
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.ENTRIES) || '[]');
};

export const saveEntries = (entries: Entry[]) => {
  setStorageItem(STORAGE_KEYS.ENTRIES, JSON.stringify(entries));
  updateDiaryEntryCounts();
};

export const createEntry = (entryData: Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'wordCount' | 'photoCount'>): Entry => {
  const entries = getEntries();
  const wordCount = entryData.body ? entryData.body.trim().split(/\s+/).filter(Boolean).length : 0;
  const newEntry: Entry = {
    ...entryData,
    id: `entry-${Date.now()}`,
    wordCount,
    photoCount: entryData.photoUris ? entryData.photoUris.length : 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  entries.push(newEntry);
  saveEntries(entries);
  try {
    const user = auth.currentUser;
    if (user) {
      setDoc(doc(db, 'users', user.uid, 'entries', newEntry.id), newEntry).catch(e => console.warn('Cloud sync createEntry failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
  return newEntry;
};

export const updateEntry = (updatedEntry: Entry): Entry[] => {
  const entries = getEntries();
  const index = entries.findIndex(e => e.id === updatedEntry.id);
  if (index !== -1) {
    const wordCount = updatedEntry.body ? updatedEntry.body.trim().split(/\s+/).filter(Boolean).length : 0;
    const finalEntry = {
      ...updatedEntry,
      wordCount,
      photoCount: updatedEntry.photoUris ? updatedEntry.photoUris.length : 0,
      updatedAt: Date.now()
    };
    entries[index] = finalEntry;
    saveEntries(entries);
    try {
      const user = auth.currentUser;
      if (user) {
        setDoc(doc(db, 'users', user.uid, 'entries', finalEntry.id), finalEntry).catch(e => console.warn('Cloud sync updateEntry failed:', e));
      }
    } catch (err) {
      console.warn(err);
    }
  }
  return entries;
};

export const deleteEntry = (entryId: string) => {
  let entries = getEntries();
  entries = entries.filter(e => e.id !== entryId);
  saveEntries(entries);
  try {
    const user = auth.currentUser;
    if (user) {
      deleteDoc(doc(db, 'users', user.uid, 'entries', entryId)).catch(e => console.warn('Cloud deleteEntry failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
};

// Note CRUD
export const getNotes = (): Note[] => {
  initializeDatabase();
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.NOTES) || '[]');
};

export const saveNotes = (notes: Note[]) => {
  setStorageItem(STORAGE_KEYS.NOTES, JSON.stringify(notes));
};

export const createNote = (noteData: Omit<Note, 'id' | 'createdAt' | 'updatedAt'>): Note => {
  const notes = getNotes();
  const newNote: Note = {
    ...noteData,
    id: `note-${Date.now()}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  notes.push(newNote);
  saveNotes(notes);
  try {
    const user = auth.currentUser;
    if (user) {
      setDoc(doc(db, 'users', user.uid, 'notes', newNote.id), newNote).catch(e => console.warn('Cloud sync createNote failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
  return newNote;
};

export const updateNote = (updatedNote: Note): Note[] => {
  const notes = getNotes();
  const index = notes.findIndex(n => n.id === updatedNote.id);
  if (index !== -1) {
    const finalNote = {
      ...updatedNote,
      updatedAt: Date.now()
    };
    notes[index] = finalNote;
    saveNotes(notes);
    try {
      const user = auth.currentUser;
      if (user) {
        setDoc(doc(db, 'users', user.uid, 'notes', finalNote.id), finalNote).catch(e => console.warn('Cloud sync updateNote failed:', e));
      }
    } catch (err) {
      console.warn(err);
    }
  }
  return notes;
};

export const deleteNote = (noteId: string) => {
  let notes = getNotes();
  notes = notes.filter(n => n.id !== noteId);
  saveNotes(notes);
  try {
    const user = auth.currentUser;
    if (user) {
      deleteDoc(doc(db, 'users', user.uid, 'notes', noteId)).catch(e => console.warn('Cloud deleteNote failed:', e));
    }
  } catch (err) {
    console.warn(err);
  }
};

// Helper to keep entry counts accurate in Diaries
export const updateDiaryEntryCounts = () => {
  const diaries = JSON.parse(localStorage.getItem(STORAGE_KEYS.DIARIES) || '[]');
  const entries = JSON.parse(localStorage.getItem(STORAGE_KEYS.ENTRIES) || '[]');
  
  const updatedDiaries = diaries.map((diary: Diary) => {
    const diaryEntries = entries.filter((e: Entry) => e.diaryId === diary.id);
    
    // Sort diary entries by date to find relative updated date
    const sorted = [...diaryEntries].sort((a, b) => b.updatedAt - a.updatedAt);
    let relativeStr = diary.lastUpdated;
    if (sorted.length > 0) {
      const diffMs = Date.now() - sorted[0].updatedAt;
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffDays === 0) relativeStr = 'Today';
      else if (diffDays === 1) relativeStr = 'Yesterday';
      else relativeStr = `${diffDays} days ago`;
    } else {
      relativeStr = 'No entries yet';
    }

    return {
      ...diary,
      entryCount: diaryEntries.length,
      lastUpdated: relativeStr
    };
  });
  
  setStorageItem(STORAGE_KEYS.DIARIES, JSON.stringify(updatedDiaries));
};

// Streak Calculation Logic
export const calculateStreak = (entries: Entry[]): number => {
  if (entries.length === 0) return 0;
  
  // Format local date relative helper
  const getLocalDateString = (d: Date) => {
    return d.getFullYear() + '-' + 
      String(d.getMonth() + 1).padStart(2, '0') + '-' + 
      String(d.getDate()).padStart(2, '0');
  };

  const todayStr = getLocalDateString(new Date());
  
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = getLocalDateString(yesterday);
  
  // Extract unique sorted descending entry dates
  const entryDates = Array.from(new Set(entries.map(e => e.date))).sort().reverse();
  
  if (!entryDates.includes(todayStr) && !entryDates.includes(yesterdayStr)) {
    return 0; // Not written today or yesterday, streak is broken
  }
  
  let streak = 0;
  let currentCheckDate = entryDates.includes(todayStr) ? new Date() : yesterday;
  
  while (true) {
    const checkStr = getLocalDateString(currentCheckDate);
    if (entryDates.includes(checkStr)) {
      streak++;
      currentCheckDate.setDate(currentCheckDate.getDate() - 1);
    } else {
      break;
    }
  }
  
  return streak;
};

// Reset Database Zone
export const resetDatabase = () => {
  setStorageItem(STORAGE_KEYS.DIARIES, JSON.stringify([
    {
      id: 'diary-default',
      name: 'My Diary',
      emoji: '📔',
      color: '#8A3D55', // Velvet Fig cover default
      isLocked: false,
      entryCount: 0,
      lastUpdated: 'No entries yet'
    }
  ]));
  setStorageItem(STORAGE_KEYS.ENTRIES, JSON.stringify([]));
  setStorageItem(STORAGE_KEYS.NOTES, JSON.stringify([]));
  // Note: Reset does not delete PIN, reminder settings or storage keys per the product boundaries!
};

// Encrypted Backup Export / Import using CryptoJS AES
export const exportEncryptedBackup = (password: string): string => {
  const diaries = getDiaries();
  const entries = getEntries();
  const notes = getNotes();
  const settings = getAppSettings();
  const userProfile = getUserProfile();
  
  const backupData: DiaryBackupData = {
    version: '1.0.0',
    diaries,
    entries,
    notes,
    settings,
    userProfile
  };
  
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(backupData), password).toString();
  return ciphertext;
};

export const importEncryptedBackup = (encryptedData: string, password: string): boolean => {
  try {
    const bytes = CryptoJS.AES.decrypt(encryptedData, password);
    const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
    if (!decryptedStr) return false;
    
    const parsedData: DiaryBackupData = JSON.parse(decryptedStr);
    
    // Check version and shape validation
    if (parsedData.version !== '1.0.0' || !Array.isArray(parsedData.diaries) || !Array.isArray(parsedData.entries)) {
      return false;
    }
    
    // Overwrite database
    setStorageItem(STORAGE_KEYS.DIARIES, JSON.stringify(parsedData.diaries));
    setStorageItem(STORAGE_KEYS.ENTRIES, JSON.stringify(parsedData.entries));
    setStorageItem(STORAGE_KEYS.NOTES, JSON.stringify(parsedData.notes || []));
    if (parsedData.settings) {
      setStorageItem(STORAGE_KEYS.SETTINGS, JSON.stringify(parsedData.settings));
    }
    if (parsedData.userProfile) {
      setStorageItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(parsedData.userProfile));
    }
    
    updateDiaryEntryCounts();
    return true;
  } catch (error) {
    console.error('Backup import failed:', error);
    return false;
  }
};

export interface StorageDetails {
  totalBytes: number;
  textBytes: number;
  photoBytes: number;
  audioBytes: number;
  percentageUsed: number;
}

export const getStorageUsageDetails = (): StorageDetails => {
  const diaries = getDiaries();
  const entries = getEntries();
  const notes = getNotes();

  let photoBytes = 0;
  let audioBytes = 0;

  // Cover images from diaries
  diaries.forEach(d => {
    if (d.coverImage && d.coverImage.startsWith('data:')) {
      const base64Data = d.coverImage.split(',')[1] || '';
      photoBytes += Math.round((base64Data.length * 3) / 4);
    }
  });

  // Photos and audios from entries
  entries.forEach(e => {
    if (e.photoUris) {
      e.photoUris.forEach(uri => {
        if (uri.startsWith('data:')) {
          const base64Data = uri.split(',')[1] || '';
          photoBytes += Math.round((base64Data.length * 3) / 4);
        }
      });
    }
    if (e.audioUri && e.audioUri.startsWith('data:')) {
      const base64Data = e.audioUri.split(',')[1] || '';
      audioBytes += Math.round((base64Data.length * 3) / 4);
    }
    if (e.blocks) {
      e.blocks.forEach(b => {
        if (b.audioUri && b.audioUri.startsWith('data:')) {
          const base64Data = b.audioUri.split(',')[1] || '';
          audioBytes += Math.round((base64Data.length * 3) / 4);
        }
      });
    }
  });

  // Calculate total localStorage size of keys
  const keys = [
    'deardiary_diaries',
    'deardiary_entries',
    'deardiary_notes',
    'deardiary_settings',
    'deardiary_userprofile',
    'deardiary_security'
  ];
  let totalBytes = 0;
  keys.forEach(key => {
    const val = localStorage.getItem(key);
    if (val) {
      try {
        // Blob is standard across modern environments
        totalBytes += new Blob([val]).size;
      } catch (err) {
        totalBytes += val.length; // fallback
      }
    }
  });

  // Calculate text bytes as total bytes minus the estimated binary size of media
  let mediaCharCount = 0;
  diaries.forEach(d => {
    if (d.coverImage) mediaCharCount += d.coverImage.length;
  });
  entries.forEach(e => {
    if (e.photoUris) {
      e.photoUris.forEach(uri => {
        mediaCharCount += uri.length;
      });
    }
    if (e.audioUri) mediaCharCount += e.audioUri.length;
    if (e.blocks) {
      e.blocks.forEach(b => {
        if (b.audioUri) mediaCharCount += b.audioUri.length;
      });
    }
  });

  const textBytes = Math.max(0, totalBytes - mediaCharCount);

  const ONE_GB = 1024 * 1024 * 1024;
  const percentageUsed = Math.min(100, (totalBytes / ONE_GB) * 100);

  return {
    totalBytes,
    textBytes,
    photoBytes,
    audioBytes,
    percentageUsed
  };
};
