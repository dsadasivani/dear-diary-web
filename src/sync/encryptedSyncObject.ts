import type { SyncObjectKind } from '../types';
import { ACCOUNT_ROOT_KEY_BYTES } from './e2eeKeyPackage';

export interface EncryptedSyncObjectHeader {
  version: 1;
  cipher: 'AES-256-GCM';
  objectKind: SyncObjectKind;
  nonce: string;
  createdAt: string;
  keyEpoch?: number;
}

export interface EncryptedSyncObject {
  bytes: Uint8Array;
  sha256: string;
  header: EncryptedSyncObjectHeader;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function'
    ? atob(value)
    : Buffer.from(value, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const importRootKey = (accountRootKey: Uint8Array): Promise<CryptoKey> => {
  if (accountRootKey.length !== ACCOUNT_ROOT_KEY_BYTES) {
    throw new Error(`Account root key must be ${ACCOUNT_ROOT_KEY_BYTES} bytes.`);
  }
  return crypto.subtle.importKey('raw', accountRootKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const encryptSyncPayload = async (
  accountRootKey: Uint8Array,
  objectKind: SyncObjectKind,
  payload: Uint8Array,
  options: { keyEpoch?: number } = {},
): Promise<EncryptedSyncObject> => {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const header: EncryptedSyncObjectHeader = {
    version: 1,
    cipher: 'AES-256-GCM',
    objectKind,
    nonce: bytesToBase64(nonce),
    createdAt: new Date().toISOString(),
    keyEpoch: options.keyEpoch,
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const key = await importRootKey(accountRootKey);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: headerBytes },
    key,
    payload,
  ));
  const envelope = encoder.encode(JSON.stringify({
    header,
    ciphertext: bytesToBase64(ciphertext),
  }));
  return {
    bytes: envelope,
    sha256: await sha256Hex(envelope),
    header,
  };
};

export const decryptSyncPayload = async (
  accountRootKey: Uint8Array,
  bytes: Uint8Array,
): Promise<{ objectKind: SyncObjectKind; payload: Uint8Array }> => {
  const envelope = JSON.parse(decoder.decode(bytes)) as {
    header: EncryptedSyncObjectHeader;
    ciphertext: string;
  };
  if (envelope.header.version !== 1 || envelope.header.cipher !== 'AES-256-GCM') {
    throw new Error('Encrypted sync object version is not supported.');
  }
  const headerBytes = encoder.encode(JSON.stringify(envelope.header));
  const key = await importRootKey(accountRootKey);
  try {
    const payload = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.header.nonce),
        additionalData: headerBytes,
      },
      key,
      base64ToBytes(envelope.ciphertext),
    ));
    return { objectKind: envelope.header.objectKind, payload };
  } catch {
    throw new Error('Encrypted sync object authentication failed.');
  }
};
