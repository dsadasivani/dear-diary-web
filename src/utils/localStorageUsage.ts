import type { RepositorySnapshot } from '../repositories/DiaryRepository';
import { parseSyncMediaReference, readMediaUri } from '../sync/syncMedia';

export interface LocalStorageUsage {
  totalBytes: number;
  writingBytes: number;
  imageBytes: number;
  audioBytes: number;
  journalCount: number;
  entryCount: number;
  noteCount: number;
  imageCount: number;
  audioCount: number;
}

type MediaReader = (uri: string) => Promise<{ bytes: Uint8Array }>;

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const uniqueLocalUris = (values: Array<string | undefined>): string[] =>
  Array.from(
    new Set(
      values.filter((value): value is string => Boolean(value) && !parseSyncMediaReference(value)),
    ),
  );

const mediaBytes = async (uris: string[], readMedia: MediaReader): Promise<number> => {
  const sizes = await Promise.all(
    uris.map(async (uri) => {
      try {
        return (await readMedia(uri)).bytes.byteLength;
      } catch {
        return 0;
      }
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
};

const snapshotWithoutMediaPayloads = (snapshot: RepositorySnapshot): RepositorySnapshot => ({
  ...snapshot,
  diaries: snapshot.diaries.map((diary) => ({
    ...diary,
    coverImage: diary.coverImage ? '[local-media]' : undefined,
  })),
  entries: snapshot.entries.map((entry) => ({
    ...entry,
    photoUris: entry.photoUris.map(() => '[local-media]'),
    audioUri: entry.audioUri ? '[local-media]' : undefined,
    blocks: entry.blocks?.map((block) => ({
      ...block,
      audioUri: block.audioUri ? '[local-media]' : undefined,
    })),
  })),
  userProfile: snapshot.userProfile
    ? {
        ...snapshot.userProfile,
        avatarUri: snapshot.userProfile.avatarUri ? '[local-media]' : undefined,
      }
    : undefined,
});

export const calculateLocalStorageUsage = async (
  snapshot: RepositorySnapshot,
  readMedia: MediaReader = readMediaUri,
): Promise<LocalStorageUsage> => {
  const imageUris = uniqueLocalUris([
    ...snapshot.diaries.map((diary) => diary.coverImage),
    ...snapshot.entries.flatMap((entry) => entry.photoUris),
    snapshot.userProfile?.avatarUri,
  ]);
  const audioUris = uniqueLocalUris([
    ...snapshot.entries.map((entry) => entry.audioUri),
    ...snapshot.entries.flatMap((entry) => entry.blocks?.map((block) => block.audioUri) || []),
  ]);
  const [imageBytes, audioBytes] = await Promise.all([
    mediaBytes(imageUris, readMedia),
    mediaBytes(audioUris, readMedia),
  ]);
  const writingBytes = encodedBytes(snapshotWithoutMediaPayloads(snapshot));

  return {
    totalBytes: writingBytes + imageBytes + audioBytes,
    writingBytes,
    imageBytes,
    audioBytes,
    journalCount: snapshot.diaries.length,
    entryCount: snapshot.entries.length,
    noteCount: snapshot.notes.length,
    imageCount: imageUris.length,
    audioCount: audioUris.length,
  };
};
