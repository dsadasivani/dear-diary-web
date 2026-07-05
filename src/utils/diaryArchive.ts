import { unzipSync, zipSync } from 'fflate';
import type { Diary, Entry } from '../types';
import { diaryRepository } from '../repositories';
import { persistMediaDataUri, type MediaKind } from '../mobile/mediaStorage';
import { decryptBackupWithPassphrase, encryptBackupWithPassphrase } from './backupEncryption';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MANIFEST_FILE = 'manifest.json';
const DIARY_FILE = 'diary.json';
const TEXT_FILE = 'diary.txt';

interface DiaryArchiveAsset {
  id: string;
  path: string;
  kind: MediaKind;
  mimeType: string;
}

interface DiaryArchivePayload {
  version: '1.0.0';
  exportedAt: string;
  diary: Diary;
  entries: Entry[];
  mediaAssets: DiaryArchiveAsset[];
}

interface DiaryArchiveManifest {
  schemaVersion: 1;
  archiveType: 'diary';
  createdAt: string;
  diaryName: string;
  entryCount: number;
  mediaCount: number;
  checksum: string;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const extensionFromMime = (mimeType: string, kind: MediaKind): string => (
  mimeType.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') || (kind === 'audio' ? 'webm' : 'jpg')
);

const readMedia = async (uri: string): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Unable to read diary media (${response.status}).`);
  const blob = await response.blob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type || 'application/octet-stream' };
};

const checksumFiles = async (files: Record<string, Uint8Array>): Promise<string> => {
  const names = Object.keys(files).sort();
  const total = names.reduce((sum, name) => sum + encoder.encode(name).length + files[name].length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    joined.set(nameBytes, offset);
    offset += nameBytes.length;
    joined.set(files[name], offset);
    offset += files[name].length;
  }
  const digest = await crypto.subtle.digest('SHA-256', joined);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const diaryAsText = (diary: Diary, entries: Entry[]): string => {
  const pages = [...entries].sort((a, b) => a.date.localeCompare(b.date)).map(entry => [
    `${entry.date}${entry.time ? ` ${entry.time}` : ''} — ${entry.title}`,
    `Mood: ${entry.moodEmoji} ${entry.moodName}`,
    `Tags: ${entry.tags.map(tag => `#${tag}`).join(', ') || 'None'}`,
    entry.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
  ].join('\n'));
  return `${diary.name}\n${'='.repeat(diary.name.length)}\n\n${pages.join('\n\n---\n\n')}\n`;
};

export const exportDiaryArchive = async (
  sourceDiary: Diary,
  sourceEntries: Entry[],
  passphrase: string,
): Promise<Uint8Array> => {
  const diary = structuredClone(sourceDiary);
  const entries = structuredClone(sourceEntries.filter(entry => entry.diaryId === diary.id));
  const mediaAssets: DiaryArchiveAsset[] = [];
  const mediaFiles: Record<string, Uint8Array> = {};

  const addMedia = async (uri: string | undefined, kind: MediaKind): Promise<string | undefined> => {
    if (!uri) return uri;
    const media = await readMedia(uri);
    const id = `${kind}-${mediaAssets.length}-${crypto.randomUUID()}`;
    const path = `media/${id}.${extensionFromMime(media.mimeType, kind)}`;
    mediaAssets.push({ id, path, kind, mimeType: media.mimeType });
    mediaFiles[path] = media.bytes;
    return `media://${id}`;
  };

  diary.coverImage = await addMedia(diary.coverImage, 'cover');
  for (const entry of entries) {
    entry.photoUris = await Promise.all((entry.photoUris || []).map(uri => addMedia(uri, 'photo') as Promise<string>));
    entry.audioUri = await addMedia(entry.audioUri, 'audio');
    for (const block of entry.blocks || []) block.audioUri = await addMedia(block.audioUri, 'audio');
  }

  const payload: DiaryArchivePayload = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    diary,
    entries,
    mediaAssets,
  };
  const contentFiles = {
    [DIARY_FILE]: encoder.encode(JSON.stringify(payload)),
    [TEXT_FILE]: encoder.encode(diaryAsText(sourceDiary, sourceEntries)),
    ...mediaFiles,
  };
  const manifest: DiaryArchiveManifest = {
    schemaVersion: 1,
    archiveType: 'diary',
    createdAt: new Date().toISOString(),
    diaryName: sourceDiary.name,
    entryCount: entries.length,
    mediaCount: mediaAssets.length,
    checksum: await checksumFiles(contentFiles),
  };
  const zipped = zipSync({ [MANIFEST_FILE]: encoder.encode(JSON.stringify(manifest)), ...contentFiles });
  return encryptBackupWithPassphrase(zipped, passphrase);
};

export const importDiaryArchive = async (encrypted: Uint8Array, passphrase: string): Promise<Diary> => {
  const zipped = await decryptBackupWithPassphrase(encrypted, passphrase);
  const files = unzipSync(zipped);
  if (!files[MANIFEST_FILE] || !files[DIARY_FILE] || !files[TEXT_FILE]) throw new Error('Diary archive is missing required files.');
  const manifest = JSON.parse(decoder.decode(files[MANIFEST_FILE])) as DiaryArchiveManifest;
  const payload = JSON.parse(decoder.decode(files[DIARY_FILE])) as DiaryArchivePayload;
  if (manifest.schemaVersion !== 1 || manifest.archiveType !== 'diary' || payload.version !== '1.0.0') {
    throw new Error('Diary archive version is not supported.');
  }
  if (!payload.diary || !Array.isArray(payload.entries) || !Array.isArray(payload.mediaAssets)) {
    throw new Error('Diary archive data is incomplete.');
  }
  const contentFiles = Object.fromEntries(Object.entries(files).filter(([path]) => path !== MANIFEST_FILE));
  if (await checksumFiles(contentFiles) !== manifest.checksum) throw new Error('Diary archive checksum did not match.');
  for (const asset of payload.mediaAssets) {
    if (!files[asset.path]) throw new Error(`Diary archive is missing ${asset.path}.`);
  }

  const mediaMap = new Map<string, string>();
  for (const asset of payload.mediaAssets) {
    const dataUri = `data:${asset.mimeType};base64,${bytesToBase64(files[asset.path])}`;
    mediaMap.set(`media://${asset.id}`, await persistMediaDataUri(dataUri, asset.kind, asset.mimeType));
  }

  const current = await diaryRepository.exportSnapshot();
  const existingNames = new Set(current.diaries.map(diary => diary.name.toLocaleLowerCase()));
  const diaryId = `diary-${crypto.randomUUID()}`;
  const importedDiary: Diary = {
    ...structuredClone(payload.diary),
    id: diaryId,
    name: existingNames.has(payload.diary.name.toLocaleLowerCase()) ? `${payload.diary.name} (Imported)` : payload.diary.name,
    coverImage: payload.diary.coverImage ? mediaMap.get(payload.diary.coverImage) || payload.diary.coverImage : undefined,
    entryCount: payload.entries.length,
  };
  const importedEntries = payload.entries.map(entry => ({
    ...structuredClone(entry),
    id: `entry-${crypto.randomUUID()}`,
    diaryId,
    photoUris: (entry.photoUris || []).map(uri => mediaMap.get(uri) || uri),
    audioUri: entry.audioUri ? mediaMap.get(entry.audioUri) || entry.audioUri : undefined,
    blocks: entry.blocks?.map(block => ({
      ...block,
      id: `block-${crypto.randomUUID()}`,
      audioUri: block.audioUri ? mediaMap.get(block.audioUri) || block.audioUri : undefined,
    })),
  }));
  await diaryRepository.importSnapshot({
    ...current,
    diaries: [...current.diaries, importedDiary],
    entries: [...current.entries, ...importedEntries],
  }, 'replace-portable');
  return importedDiary;
};
