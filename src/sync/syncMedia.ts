import { Capacitor } from '@capacitor/core';
import { fileStorageService } from '../platform/filesystem';
import { isNativePlatform } from '../platform';

export interface DecodedSyncMediaPayload {
  mediaId: string;
  mimeType: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MEDIA_REFERENCE = /^ddmedia:(\d+):([a-zA-Z0-9-]+)$/;

export const createSyncMediaReference = (sequence: number, mediaId: string): string => {
  if (!Number.isInteger(sequence) || sequence < 1 || !mediaId) throw new Error('Sync media reference is invalid.');
  return `ddmedia:${sequence}:${mediaId}`;
};

export const parseSyncMediaReference = (value: string | undefined): { sequence: number; mediaId: string } | null => {
  if (!value) return null;
  const match = MEDIA_REFERENCE.exec(value);
  return match ? { sequence: Number(match[1]), mediaId: match[2] } : null;
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
  const headerLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
  if (headerLength < 2 || 4 + headerLength > payload.byteLength) throw new Error('Encrypted media header is invalid.');
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

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};

export const readMediaUri = async (uri: string): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  if (uri.startsWith('data:')) {
    const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(uri);
    if (!match) throw new Error('Media data URI is invalid.');
    return {
      mimeType: match[1] || 'application/octet-stream',
      bytes: uri.includes(';base64,')
        ? base64ToBytes(match[2])
        : encoder.encode(decodeURIComponent(match[2])),
    };
  }
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Local media could not be read (${response.status}).`);
  const blob = await response.blob();
  return {
    mimeType: blob.type || 'application/octet-stream',
    bytes: new Uint8Array(await blob.arrayBuffer()),
  };
};

const extensionFromMime = (mimeType: string): string => {
  const subtype = mimeType.split('/')[1]?.split(/[;+]/)[0]?.replace(/[^a-zA-Z0-9]/g, '');
  return subtype || 'bin';
};

export const cacheSyncMedia = async (
  mediaId: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> => {
  const dataUri = `data:${mimeType};base64,${bytesToBase64(bytes)}`;
  if (!isNativePlatform()) return dataUri;
  const path = `media/sync-${mediaId}.${extensionFromMime(mimeType)}`;
  const stored = await fileStorageService.writeBase64Atomic(path, bytesToBase64(bytes));
  return Capacitor.convertFileSrc(stored.uri);
};
