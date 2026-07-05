import CryptoJS from 'crypto-js';
import type { DiaryBackupData } from '../types';
import { diaryRepository } from '../repositories';
import { persistMediaDataUri, readImageAsDataUri } from '../mobile/mediaStorage';

const makeProfilePortable = async (profile: DiaryBackupData['userProfile']): Promise<DiaryBackupData['userProfile']> => {
  if (!profile?.avatarUri) return profile;
  try {
    const image = await readImageAsDataUri(profile.avatarUri);
    return { ...profile, avatarUri: image?.dataUri };
  } catch (error) {
    console.warn('Profile avatar could not be included in the encrypted export:', error);
    return { ...profile, avatarUri: undefined };
  }
};

const restorePortableProfile = async (profile: DiaryBackupData['userProfile']): Promise<DiaryBackupData['userProfile']> => {
  if (!profile?.avatarUri?.startsWith('data:')) return profile;
  const image = await readImageAsDataUri(profile.avatarUri);
  if (!image) return { ...profile, avatarUri: undefined };
  return {
    ...profile,
    avatarUri: await persistMediaDataUri(image.dataUri, 'avatar', image.mimeType),
  };
};

export const exportEncryptedBackup = async (password: string): Promise<string> => {
  const snapshot = await diaryRepository.exportSnapshot();
  const backupData: DiaryBackupData = {
    version: '1.0.0',
    diaries: snapshot.diaries,
    entries: snapshot.entries,
    notes: snapshot.notes,
    settings: snapshot.settings!,
    userProfile: await makeProfilePortable(snapshot.userProfile),
  };
  return CryptoJS.AES.encrypt(JSON.stringify(backupData), password).toString();
};

export const importEncryptedBackup = async (encryptedData: string, password: string): Promise<boolean> => {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
    if (!decrypted) return false;
    const parsed = JSON.parse(decrypted) as DiaryBackupData;
    if (parsed.version !== '1.0.0' || !Array.isArray(parsed.diaries) || !Array.isArray(parsed.entries)) {
      return false;
    }

    const current = await diaryRepository.exportSnapshot();
    await diaryRepository.importSnapshot({
      ...current,
      diaries: parsed.diaries,
      entries: parsed.entries,
      notes: parsed.notes || [],
      settings: parsed.settings || current.settings,
      userProfile: await restorePortableProfile(parsed.userProfile || current.userProfile),
    }, 'replace');
    return true;
  } catch (error) {
    console.error('Backup import failed:', error);
    return false;
  }
};
