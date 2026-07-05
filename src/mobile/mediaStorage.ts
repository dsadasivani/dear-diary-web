import { Capacitor } from '@capacitor/core';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';

export type MediaKind = 'audio' | 'photo' | 'cover' | 'avatar';

const extensionFromMime = (mimeType: string, fallback: string): string => {
  const subtype = mimeType.split('/')[1]?.split(';')[0];
  return subtype || fallback;
};

const base64FromDataUri = (dataUri: string): string => (
  dataUri.includes(',') ? dataUri.split(',')[1] : dataUri
);

export const persistMediaDataUri = async (
  dataUri: string,
  kind: MediaKind,
  mimeType: string,
): Promise<string> => {
  if (!isNativePlatform()) {
    return dataUri;
  }

  const extension = extensionFromMime(mimeType, kind === 'audio' ? 'webm' : 'jpg');
  const path = `media/${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;

  try {
    const stored = await fileStorageService.writeBase64(path, base64FromDataUri(dataUri));
    return Capacitor.convertFileSrc(stored.uri);
  } catch (error) {
    console.warn(`Failed to persist ${kind} media to native filesystem:`, error);
    return dataUri;
  }
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const readImageAsDataUri = async (uri: string): Promise<{ dataUri: string; mimeType: string } | null> => {
  if (uri.startsWith('data:')) {
    const match = /^data:([^;,]+)[;,]/.exec(uri);
    const mimeType = match?.[1] || '';
    return mimeType.startsWith('image/') ? { dataUri: uri, mimeType } : null;
  }

  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Unable to download profile image (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('Google profile image response was not an image.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    dataUri: `data:${blob.type};base64,${bytesToBase64(bytes)}`,
    mimeType: blob.type,
  };
};

export const cacheRemoteProfileImage = async (imageUrl: string): Promise<string | null> => {
  const image = await readImageAsDataUri(imageUrl);
  if (!image) return null;
  return persistMediaDataUri(image.dataUri, 'avatar', image.mimeType);
};
