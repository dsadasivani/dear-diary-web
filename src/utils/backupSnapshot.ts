import { unzipSync, zipSync } from 'fflate';
import {
  AppSettings,
  BackupSchedulePreference,
  BackupManifest,
  BackupMergePreview,
  BackupMergeResult,
  Diary,
  DriveBackupSettings,
  Entry,
  Note,
  UserProfile,
} from '../types';
import { fileStorageService } from '../platform/filesystem';
import { persistMediaDataUri } from '../mobile/mediaStorage';
import type { MediaKind } from '../mobile/mediaStorage';
import { diaryRepository } from '../repositories';
import { pruneOrphanedMedia } from '../mobile/mediaGarbageCollector';
import type { RepositorySnapshot } from '../repositories/DiaryRepository';

export const BACKUP_SCHEMA_VERSION = 2;
const STORAGE_SCHEMA_VERSION = 1;
const BACKUP_DATA_FILE = 'data.json';
const BACKUP_MANIFEST_FILE = 'manifest.json';

interface BackupMediaAsset {
  id: string;
  path: string;
  kind: MediaKind;
  mimeType: string;
  originalUri: string;
}

export interface DearDiaryBackupPayload {
  version: '2.0.0' | '3.0.0';
  exportedAt: string;
  diaries: Diary[];
  entries: Entry[];
  notes: Note[];
  settings: AppSettings;
  userProfile: UserProfile;
  security?: unknown;
  driveBackupSettings?: DriveBackupSettings;
  backupSchedule?: BackupSchedulePreference;
  mediaAssets: BackupMediaAsset[];
}

export interface BackupBundle {
  bytes: Uint8Array;
  manifest: BackupManifest;
}

export interface BackupCreationContext {
  deviceId: string;
  contentRevision: number;
  parentBackupFileId?: string;
  schedule?: BackupSchedulePreference;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const extensionFromMime = (mimeType: string, kind: MediaKind): string => {
  const subtype = mimeType.split('/')[1]?.split(';')[0];
  if (subtype) {
    return subtype.replace('jpeg', 'jpg');
  }
  return kind === 'audio' ? 'webm' : 'jpg';
};

const canBackupUri = (uri: string): boolean =>
  uri.startsWith('data:') ||
  uri.startsWith('blob:') ||
  uri.startsWith('file:') ||
  uri.includes('_capacitor_file_') ||
  uri.includes('/_capacitor_file_');

const readMediaBytes = async (
  uri: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> => {
  if (!canBackupUri(uri)) {
    return null;
  }

  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Unable to read media for backup (${response.status}).`);
  }

  const blob = await response.blob();
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: blob.type || 'application/octet-stream',
  };
};

const makeMediaId = (kind: MediaKind, index: number): string =>
  `${kind}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;

const sanitizeSettings = (settings: AppSettings): AppSettings => {
  const { remindersEnabled, reminderTime, customTags, customMoods, theme } = settings;
  return {
    remindersEnabled,
    reminderTime,
    customTags,
    customMoods,
    theme,
  };
};

const addMediaAsset = async (
  uri: string | undefined,
  kind: MediaKind,
  mediaAssets: BackupMediaAsset[],
  mediaFiles: Record<string, Uint8Array>,
): Promise<string | undefined> => {
  if (!uri) {
    return uri;
  }

  const media = await readMediaBytes(uri);
  if (!media) {
    return uri;
  }

  const id = makeMediaId(kind, mediaAssets.length);
  const extension = extensionFromMime(media.mimeType, kind);
  const path = `media/${id}.${extension}`;
  mediaAssets.push({
    id,
    path,
    kind,
    mimeType: media.mimeType,
    originalUri: uri,
  });
  mediaFiles[path] = media.bytes;
  return `media://${id}`;
};

const calculateChecksum = async (
  dataJson: string,
  mediaFiles: Record<string, Uint8Array>,
): Promise<string> => {
  const fileNames = Object.keys(mediaFiles).sort();
  const totalBytes = fileNames.reduce(
    (sum, fileName) => sum + textEncoder.encode(fileName).length + mediaFiles[fileName].length,
    textEncoder.encode(dataJson).length,
  );
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  const append = (next: Uint8Array) => {
    bytes.set(next, offset);
    offset += next.length;
  };

  append(textEncoder.encode(dataJson));
  fileNames.forEach((fileName) => {
    append(textEncoder.encode(fileName));
    append(mediaFiles[fileName]);
  });

  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const createPayloadAndMedia = async (
  context: BackupCreationContext,
): Promise<{
  payload: DearDiaryBackupPayload;
  mediaFiles: Record<string, Uint8Array>;
}> => {
  const snapshot = await diaryRepository.exportSnapshot();
  const diaries = cloneJson(snapshot.diaries);
  const entries = cloneJson(snapshot.entries);
  const notes = cloneJson(snapshot.notes);
  const userProfile = cloneJson(snapshot.userProfile!);
  const mediaAssets: BackupMediaAsset[] = [];
  const mediaFiles: Record<string, Uint8Array> = {};

  for (const diary of diaries) {
    diary.coverImage = await addMediaAsset(diary.coverImage, 'cover', mediaAssets, mediaFiles);
  }

  for (const entry of entries) {
    entry.photoUris = await Promise.all(
      (entry.photoUris || []).map(
        (uri) => addMediaAsset(uri, 'photo', mediaAssets, mediaFiles) as Promise<string>,
      ),
    );
    entry.audioUri = await addMediaAsset(entry.audioUri, 'audio', mediaAssets, mediaFiles);
    if (entry.blocks) {
      for (const block of entry.blocks) {
        block.audioUri = await addMediaAsset(block.audioUri, 'audio', mediaAssets, mediaFiles);
      }
    }
  }

  userProfile.avatarUri = await addMediaAsset(
    userProfile.avatarUri,
    'avatar',
    mediaAssets,
    mediaFiles,
  );

  return {
    payload: {
      version: '3.0.0',
      exportedAt: new Date().toISOString(),
      diaries,
      entries,
      notes,
      settings: sanitizeSettings(cloneJson(snapshot.settings!)),
      userProfile,
      backupSchedule: context.schedule ? cloneJson(context.schedule) : undefined,
      mediaAssets,
    },
    mediaFiles,
  };
};

const getAppVersion = (): string =>
  (import.meta.env?.VITE_APP_VERSION as string | undefined)?.trim() || '1.0.0';

const getBackupCreationContext = async (): Promise<BackupCreationContext> => {
  const settings = await diaryRepository.getDriveBackupSettings();
  if (!settings.deviceId) throw new Error('This device does not have a backup identity.');
  return {
    deviceId: settings.deviceId,
    contentRevision: settings.contentRevision || 0,
    parentBackupFileId: settings.parentBackupFileId || settings.lastBackupFileId,
    schedule: settings.schedule,
  };
};

export const createBackupBundle = async (
  providedContext?: BackupCreationContext,
): Promise<BackupBundle> => {
  const context = providedContext || (await getBackupCreationContext());
  const { payload, mediaFiles } = await createPayloadAndMedia(context);
  const dataJson = JSON.stringify(payload);
  const checksum = await calculateChecksum(dataJson, mediaFiles);
  const totalBytes = Object.values(mediaFiles).reduce(
    (sum, bytes) => sum + bytes.length,
    textEncoder.encode(dataJson).length,
  );

  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: getAppVersion(),
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    counts: {
      diaries: payload.diaries.length,
      entries: payload.entries.length,
      notes: payload.notes.length,
      media: payload.mediaAssets.length,
    },
    mediaCount: payload.mediaAssets.length,
    totalBytes,
    checksum,
    deviceId: context.deviceId,
    contentRevision: context.contentRevision,
    parentBackupFileId: context.parentBackupFileId,
  };

  const bytes = zipSync({
    [BACKUP_MANIFEST_FILE]: textEncoder.encode(JSON.stringify(manifest)),
    [BACKUP_DATA_FILE]: textEncoder.encode(dataJson),
    ...mediaFiles,
  });

  return { bytes, manifest };
};

const createPreRestoreSafetySnapshot = async (): Promise<void> => {
  try {
    const { bytes } = await createBackupBundle();
    const path = `backups/pre-restore-${Date.now()}.ddb`;
    await fileStorageService.writeBase64(path, bytesToBase64(bytes));
    localStorage.setItem('deardiary_last_pre_restore_backup', path);
  } catch (error) {
    console.warn('Could not create pre-restore safety snapshot:', error);
  }
};

const mediaBytesToDataUri = (bytes: Uint8Array, mimeType: string): string =>
  `data:${mimeType};base64,${bytesToBase64(bytes)}`;

const restoreMediaAssets = async (
  payload: DearDiaryBackupPayload,
  files: Record<string, Uint8Array>,
): Promise<Map<string, string>> => {
  const restoredUris = new Map<string, string>();

  for (const asset of payload.mediaAssets || []) {
    const bytes = files[asset.path];
    if (!bytes) {
      throw new Error(`Backup is missing media file ${asset.path}.`);
    }
    const dataUri = mediaBytesToDataUri(bytes, asset.mimeType);
    const restoredUri = await persistMediaDataUri(dataUri, asset.kind, asset.mimeType);
    restoredUris.set(`media://${asset.id}`, restoredUri);
  }

  return restoredUris;
};

const replaceMediaRefs = (payload: DearDiaryBackupPayload, mediaMap: Map<string, string>): void => {
  payload.diaries.forEach((diary) => {
    if (diary.coverImage && mediaMap.has(diary.coverImage)) {
      diary.coverImage = mediaMap.get(diary.coverImage);
    }
  });

  payload.entries.forEach((entry) => {
    entry.photoUris = (entry.photoUris || []).map((uri) => mediaMap.get(uri) || uri);
    if (entry.audioUri && mediaMap.has(entry.audioUri)) {
      entry.audioUri = mediaMap.get(entry.audioUri);
    }
    entry.blocks?.forEach((block) => {
      if (block.audioUri && mediaMap.has(block.audioUri)) {
        block.audioUri = mediaMap.get(block.audioUri);
      }
    });
  });

  if (payload.userProfile.avatarUri && mediaMap.has(payload.userProfile.avatarUri)) {
    payload.userProfile.avatarUri = mediaMap.get(payload.userProfile.avatarUri);
  }
};

const validateBackup = async (
  manifest: BackupManifest,
  payload: DearDiaryBackupPayload,
  dataJson: string,
  mediaFiles: Record<string, Uint8Array>,
): Promise<void> => {
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup schema version ${manifest.schemaVersion}.`);
  }
  if (payload.version !== '2.0.0' && payload.version !== '3.0.0') {
    throw new Error('Unsupported Dear Diary backup payload.');
  }
  if (
    !Array.isArray(payload.diaries) ||
    !Array.isArray(payload.entries) ||
    !Array.isArray(payload.notes)
  ) {
    throw new Error('Backup data is incomplete.');
  }

  const checksum = await calculateChecksum(dataJson, mediaFiles);
  if (checksum !== manifest.checksum) {
    throw new Error('Backup checksum did not match. The file may be incomplete or corrupted.');
  }
};

export const restoreBackupBundle = async (bytes: Uint8Array): Promise<BackupManifest> => {
  const { files, manifest, payload } = await validateBackupBundleBytes(bytes);
  await createPreRestoreSafetySnapshot();

  const mediaFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith('media/')),
  );
  const restoredMedia = await restoreMediaAssets(payload, mediaFiles);
  replaceMediaRefs(payload, restoredMedia);

  await diaryRepository.importSnapshot(
    {
      diaries: payload.diaries,
      entries: payload.entries,
      notes: payload.notes,
      settings: sanitizeSettings(payload.settings),
      userProfile: payload.userProfile,
    },
    'replace-portable',
  );
  await pruneOrphanedMedia(0).catch((error) =>
    console.warn('Post-restore media cleanup will retry later:', error),
  );

  const currentBackupSettings = await diaryRepository.getDriveBackupSettings();
  await diaryRepository.saveDriveBackupSettings({
    ...currentBackupSettings,
    schedule: payload.backupSchedule || currentBackupSettings.schedule,
    lastRestoreAt: Date.now(),
  });

  return manifest;
};

const payloadSnapshot = (payload: DearDiaryBackupPayload): RepositorySnapshot => ({
  diaries: payload.diaries,
  entries: payload.entries,
  notes: payload.notes,
  settings: sanitizeSettings(payload.settings),
  userProfile: payload.userProfile,
});

export const previewBackupBundleMerge = async (
  bytes: Uint8Array,
): Promise<{
  manifest: BackupManifest;
  preview: BackupMergePreview;
}> => {
  const { manifest, payload } = await validateBackupBundleBytes(bytes);
  return {
    manifest,
    preview: await diaryRepository.previewPortableMerge(
      payloadSnapshot(payload),
      payload.mediaAssets?.length || 0,
    ),
  };
};

export const mergeBackupBundle = async (
  bytes: Uint8Array,
): Promise<{
  manifest: BackupManifest;
  result: BackupMergeResult;
}> => {
  const { files, manifest, payload } = await validateBackupBundleBytes(bytes);
  await createPreRestoreSafetySnapshot();
  const mediaFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith('media/')),
  );
  const restoredMedia = await restoreMediaAssets(payload, mediaFiles);
  replaceMediaRefs(payload, restoredMedia);
  const result = await diaryRepository.mergePortableSnapshot(
    payloadSnapshot(payload),
    payload.mediaAssets?.length || 0,
  );
  const currentBackupSettings = await diaryRepository.getDriveBackupSettings();
  await diaryRepository.saveDriveBackupSettings({
    ...currentBackupSettings,
    schedule: payload.backupSchedule || currentBackupSettings.schedule,
    lastRestoreAt: Date.now(),
  });
  return { manifest, result };
};

export const validateBackupBundleBytes = async (
  bytes: Uint8Array,
): Promise<{
  files: Record<string, Uint8Array>;
  manifest: BackupManifest;
  payload: DearDiaryBackupPayload;
}> => {
  const files = unzipSync(bytes);
  const manifestBytes = files[BACKUP_MANIFEST_FILE];
  const dataBytes = files[BACKUP_DATA_FILE];
  if (!manifestBytes || !dataBytes) {
    throw new Error('Backup bundle is missing required files.');
  }

  const manifest = JSON.parse(textDecoder.decode(manifestBytes)) as BackupManifest;
  const dataJson = textDecoder.decode(dataBytes);
  const payload = JSON.parse(dataJson) as DearDiaryBackupPayload;
  const mediaFiles = Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith('media/')),
  );

  await validateBackup(manifest, payload, dataJson, mediaFiles);
  return { files, manifest, payload };
};

export const base64BackupBundleToBytes = (base64: string): Uint8Array => base64ToBytes(base64);
