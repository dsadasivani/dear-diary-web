import CryptoJS from 'crypto-js';
import type { DiaryBackupData } from '../types';
import { diaryRepository } from '../repositories';

export const exportEncryptedBackup = async (password: string): Promise<string> => {
  const snapshot = await diaryRepository.exportSnapshot();
  const backupData: DiaryBackupData = {
    version: '1.0.0',
    diaries: snapshot.diaries,
    entries: snapshot.entries,
    notes: snapshot.notes,
    settings: snapshot.settings!,
    userProfile: snapshot.userProfile,
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
      userProfile: parsed.userProfile || current.userProfile,
    }, 'replace');
    return true;
  } catch (error) {
    console.error('Backup import failed:', error);
    return false;
  }
};
