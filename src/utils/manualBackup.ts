import CryptoJS from 'crypto-js';
import type { DiaryBackupData } from '../types';
import { diaryRepository } from '../repositories';
import { createBackupBundle, restoreBackupBundle } from './backupSnapshot';
import { decryptBackupWithPassphrase, encryptBackupWithPassphrase } from './backupEncryption';
import { persistMediaDataUri, readImageAsDataUri } from '../mobile/mediaStorage';

const restorePortableProfile = async (profile: DiaryBackupData['userProfile']): Promise<DiaryBackupData['userProfile']> => {
  if (!profile?.avatarUri?.startsWith('data:')) return profile;
  const image = await readImageAsDataUri(profile.avatarUri);
  if (!image) return { ...profile, avatarUri: undefined };
  return { ...profile, avatarUri: await persistMediaDataUri(image.dataUri, 'avatar', image.mimeType) };
};

export const exportEncryptedBackup = async (password: string): Promise<Uint8Array> => {
  const bundle = await createBackupBundle();
  return encryptBackupWithPassphrase(bundle.bytes, password);
};

const importLegacyEncryptedBackup = async (encryptedData: string, password: string): Promise<boolean> => {
  const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
  if (!decrypted) return false;
  const parsed = JSON.parse(decrypted) as DiaryBackupData;
  if (parsed.version !== '1.0.0' || !Array.isArray(parsed.diaries) || !Array.isArray(parsed.entries)) return false;
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
};

export const importEncryptedBackup = async (
  encryptedData: Uint8Array | string,
  password: string,
): Promise<boolean> => {
  try {
    if (typeof encryptedData === 'string') return importLegacyEncryptedBackup(encryptedData, password);
    const bundle = await decryptBackupWithPassphrase(encryptedData, password);
    await restoreBackupBundle(bundle);
    return true;
  } catch (error) {
    console.error('Backup import failed:', error);
    return false;
  }
};
