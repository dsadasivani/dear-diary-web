import type { AppSettings, Diary, Entry, Note, SecurityConfig, UserProfile } from '../types';

export interface StorageDetails {
  totalBytes: number;
  textBytes: number;
  photoBytes: number;
  audioBytes: number;
  percentageUsed: number;
}

const dataUriBytes = (uri: string | undefined): number => {
  if (!uri?.startsWith('data:')) return 0;
  const encoded = uri.split(',')[1] || '';
  return Math.round((encoded.length * 3) / 4);
};

export const calculateStorageUsage = (
  diaries: Diary[],
  entries: Entry[],
  notes: Note[],
  settings: AppSettings,
  profile: UserProfile,
  security: SecurityConfig,
): StorageDetails => {
  const photoBytes = diaries.reduce((sum, diary) => sum + dataUriBytes(diary.coverImage), 0) +
    entries.reduce(
      (sum, entry) => sum + (entry.photoUris || []).reduce((photoSum, uri) => photoSum + dataUriBytes(uri), 0),
      0,
    );
  const audioBytes = entries.reduce((sum, entry) => (
    sum +
    dataUriBytes(entry.audioUri) +
    (entry.blocks || []).reduce((blockSum, block) => blockSum + dataUriBytes(block.audioUri), 0)
  ), 0);
  const serialized = JSON.stringify({ diaries, entries, notes, settings, profile, security });
  const totalBytes = new TextEncoder().encode(serialized).length;
  const textBytes = Math.max(0, totalBytes - photoBytes - audioBytes);
  const oneGb = 1024 * 1024 * 1024;

  return {
    totalBytes,
    textBytes,
    photoBytes,
    audioBytes,
    percentageUsed: Math.min(100, (totalBytes / oneGb) * 100),
  };
};
