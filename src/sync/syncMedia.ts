import { Capacitor } from '@capacitor/core';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';
import { measureAsync } from '../utils/performance';

export interface DecodedSyncMediaPayload {
  mediaId: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface DecodedSyncThumbnailPayload extends DecodedSyncMediaPayload {
  source: 'thumbnail';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LEGACY_MEDIA_REFERENCE = /^ddmedia:(\d+):([a-zA-Z0-9-]+)$/;
const STABLE_MEDIA_REFERENCE = /^ddmedia:v2:([a-zA-Z0-9-]+):([a-zA-Z0-9_-]+)$/;

export const createSyncMediaReference = (sequence: number, mediaId: string): string => {
  if (!Number.isInteger(sequence) || sequence < 1 || !mediaId)
    throw new Error('Sync media reference is invalid.');
  return `ddmedia:${sequence}:${mediaId}`;
};

export const createStableSyncMediaReference = (mediaId: string, driveFileId: string): string => {
  if (!mediaId || !driveFileId) throw new Error('Sync media reference is invalid.');
  return `ddmedia:v2:${mediaId}:${driveFileId}`;
};

export const parseSyncMediaReference = (
  value: string | undefined,
): { sequence?: number; mediaId: string; driveFileId?: string } | null => {
  if (!value) return null;
  const stable = STABLE_MEDIA_REFERENCE.exec(value);
  if (stable) return { mediaId: stable[1], driveFileId: stable[2] };
  const legacy = LEGACY_MEDIA_REFERENCE.exec(value);
  return legacy ? { sequence: Number(legacy[1]), mediaId: legacy[2] } : null;
};

export const encodeSyncMediaPayload = (
  mediaId: string,
  mimeType: string,
  bytes: Uint8Array,
): Uint8Array => {
  if (!mediaId || !mimeType) throw new Error('Sync media metadata is incomplete.');
  const header = encoder.encode(JSON.stringify({ version: 1, mediaId, mimeType }));
  const payload = new Uint8Array(4 + header.byteLength + bytes.byteLength);
  new DataView(payload.buffer).setUint32(0, header.byteLength, false);
  payload.set(header, 4);
  payload.set(bytes, 4 + header.byteLength);
  return payload;
};

export const decodeSyncMediaPayload = (payload: Uint8Array): DecodedSyncMediaPayload => {
  if (payload.byteLength < 5) throw new Error('Encrypted media payload is incomplete.');
  const headerLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0, false);
  if (headerLength < 2 || 4 + headerLength > payload.byteLength)
    throw new Error('Encrypted media header is invalid.');
  const header = JSON.parse(decoder.decode(payload.subarray(4, 4 + headerLength))) as {
    version?: number;
    mediaId?: string;
    mimeType?: string;
  };
  if (header.version !== 1 || !header.mediaId || !header.mimeType) {
    throw new Error('Encrypted media payload is unsupported.');
  }
  return {
    mediaId: header.mediaId,
    mimeType: header.mimeType,
    bytes: payload.slice(4 + headerLength),
  };
};

export const encodeSyncThumbnailPayload = (
  mediaId: string,
  mimeType: string,
  bytes: Uint8Array,
): Uint8Array => {
  if (!mediaId || !mimeType) throw new Error('Sync thumbnail metadata is incomplete.');
  const header = encoder.encode(
    JSON.stringify({ version: 1, mediaId, mimeType, source: 'thumbnail' }),
  );
  const payload = new Uint8Array(4 + header.byteLength + bytes.byteLength);
  new DataView(payload.buffer).setUint32(0, header.byteLength, false);
  payload.set(header, 4);
  payload.set(bytes, 4 + header.byteLength);
  return payload;
};

export const decodeSyncThumbnailPayload = (payload: Uint8Array): DecodedSyncThumbnailPayload => {
  const decoded = decodeSyncMediaPayload(payload) as DecodedSyncThumbnailPayload;
  const headerLength = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(0, false);
  const header = JSON.parse(decoder.decode(payload.subarray(4, 4 + headerLength))) as {
    source?: string;
  };
  if (header.source !== 'thumbnail') throw new Error('Encrypted thumbnail payload is unsupported.');
  return { ...decoded, source: 'thumbnail' };
};

const base64ToBytes = (value: string): Uint8Array => {
  const normalized = value.replace(/\s/g, '');
  const binary =
    typeof atob === 'function'
      ? atob(normalized)
      : Buffer.from(normalized, 'base64').toString('binary');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
};

export const readMediaUri = async (
  uri: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  return measureAsync(
    'sync.media.read',
    async () => {
      if (uri.startsWith('data:')) {
        const commaIndex = uri.indexOf(',');
        if (commaIndex < 0) throw new Error('Media data URI is invalid.');
        const metadata = uri.slice('data:'.length, commaIndex);
        const data = uri.slice(commaIndex + 1);
        const metadataParts = metadata.split(';').filter(Boolean);
        const isBase64 = metadataParts.some((part) => part.toLowerCase() === 'base64');
        const mediaType = metadataParts.filter((part) => part.toLowerCase() !== 'base64').join(';');
        return {
          mimeType: mediaType || 'application/octet-stream',
          bytes: isBase64 ? base64ToBytes(data) : encoder.encode(decodeURIComponent(data)),
        };
      }
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`Local media could not be read (${response.status}).`);
      const blob = await response.blob();
      return {
        mimeType: blob.type || 'application/octet-stream',
        bytes: new Uint8Array(await blob.arrayBuffer()),
      };
    },
    { sourceType: uri.startsWith('data:') ? 'data' : 'url' },
  );
};

export const createImageThumbnail = async (
  media: { bytes: Uint8Array; mimeType: string },
  options: { maxDimension?: number; quality?: number } = {},
): Promise<{ bytes: Uint8Array; mimeType: string } | null> => {
  return measureAsync(
    'sync.media.thumbnail',
    async () => {
      if (!media.mimeType.startsWith('image/')) return null;
      if (
        typeof document === 'undefined' ||
        typeof Blob === 'undefined' ||
        typeof URL === 'undefined' ||
        typeof Image === 'undefined'
      ) {
        return null;
      }
      const maxDimension = options.maxDimension || 320;
      const quality = options.quality || 0.72;
      const blob = new Blob([media.bytes], { type: media.mimeType });
      const url = URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Image thumbnail decoding failed.'));
          img.src = url;
        });
        const scale = Math.min(
          1,
          maxDimension /
            Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height),
        );
        const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
        const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(image, 0, 0, width, height);
        const thumbnailBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        if (!thumbnailBlob) return null;
        return {
          mimeType: thumbnailBlob.type || 'image/jpeg',
          bytes: new Uint8Array(await thumbnailBlob.arrayBuffer()),
        };
      } catch {
        return null;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { mimeType: media.mimeType, sizeBytes: media.bytes.byteLength },
  );
};

const extensionFromMime = (mimeType: string): string => {
  const subtype = mimeType
    .split('/')[1]
    ?.split(/[;+]/)[0]
    ?.replace(/[^a-zA-Z0-9]/g, '');
  return subtype || 'bin';
};

export const cacheSyncMedia = async (
  mediaId: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> => {
  return measureAsync(
    'sync.media.cache',
    async () => {
      const dataUri = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
      if (!isNativePlatform()) return dataUri;
      const path = `media/sync-${mediaId}.${extensionFromMime(mimeType)}`;
      const stored = await fileStorageService.writeBase64Atomic(path, bytesToBase64(bytes));
      return Capacitor.convertFileSrc(stored.uri);
    },
    { mimeType, sizeBytes: bytes.byteLength },
  );
};
