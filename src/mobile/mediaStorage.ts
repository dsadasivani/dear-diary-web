import { Capacitor } from '@capacitor/core';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';

const extensionFromMime = (mimeType: string, fallback: string): string => {
  const subtype = mimeType.split('/')[1]?.split(';')[0];
  return subtype || fallback;
};

const base64FromDataUri = (dataUri: string): string => (
  dataUri.includes(',') ? dataUri.split(',')[1] : dataUri
);

export const persistMediaDataUri = async (
  dataUri: string,
  kind: 'audio' | 'photo' | 'cover',
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
