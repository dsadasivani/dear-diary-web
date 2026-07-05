import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { EncryptedEnvelopeHeader } from '../types';

const MAGIC = new TextEncoder().encode('DDE1');
const HEADER_LENGTH_BYTES = 4;
export const BACKUP_PASSPHRASE_MIN_LENGTH = 12;
export const BACKUP_KDF_ITERATIONS = 600_000;
const SECURE_STORAGE_PREFIX = 'deardiary_';
const CONTEXT_KEY_PREFIX = 'drive_backup_encryption_v1_';

interface StoredEncryptionContext {
  keyId: string;
  masterKey: string;
  salt: string;
  wrapNonce: string;
  wrappedKey: string;
  iterations: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};

const validatePassphrase = (passphrase: string): void => {
  if (passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`Backup passphrase must contain at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`);
  }
};

const deriveWrappingKey = async (passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const importMasterKey = (raw: Uint8Array): Promise<CryptoKey> => (
  crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
);

const wrapAdditionalData = (keyId: string): Uint8Array => encoder.encode(`DDE1:${keyId}`);

const createContext = async (passphrase: string): Promise<StoredEncryptionContext> => {
  validatePassphrase(passphrase);
  const masterKey = randomBytes(32);
  const salt = randomBytes(16);
  const wrapNonce = randomBytes(12);
  const keyId = crypto.randomUUID();
  const wrappingKey = await deriveWrappingKey(passphrase, salt, BACKUP_KDF_ITERATIONS);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapNonce, additionalData: wrapAdditionalData(keyId) },
    wrappingKey,
    masterKey,
  ));
  return {
    keyId,
    masterKey: bytesToBase64(masterKey),
    salt: bytesToBase64(salt),
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedKey: bytesToBase64(wrappedKey),
    iterations: BACKUP_KDF_ITERATIONS,
  };
};

const encodeEnvelope = async (payload: Uint8Array, context: StoredEncryptionContext): Promise<Uint8Array> => {
  const dataNonce = randomBytes(12);
  const header: EncryptedEnvelopeHeader = {
    version: 1,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA-256',
    iterations: context.iterations,
    salt: context.salt,
    wrapNonce: context.wrapNonce,
    wrappedKey: context.wrappedKey,
    dataNonce: bytesToBase64(dataNonce),
    keyId: context.keyId,
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const masterKey = await importMasterKey(base64ToBytes(context.masterKey));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dataNonce, additionalData: headerBytes },
    masterKey,
    payload,
  ));
  const output = new Uint8Array(MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length + ciphertext.length);
  output.set(MAGIC, 0);
  new DataView(output.buffer).setUint32(MAGIC.length, headerBytes.length, false);
  output.set(headerBytes, MAGIC.length + HEADER_LENGTH_BYTES);
  output.set(ciphertext, MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length);
  return output;
};

export const isEncryptedBackupEnvelope = (bytes: Uint8Array): boolean => (
  bytes.length >= MAGIC.length && MAGIC.every((byte, index) => bytes[index] === byte)
);

export const inspectEncryptedEnvelope = (bytes: Uint8Array): EncryptedEnvelopeHeader => {
  if (!isEncryptedBackupEnvelope(bytes) || bytes.length < MAGIC.length + HEADER_LENGTH_BYTES) {
    throw new Error('This file is not an encrypted Dear Diary archive.');
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, false);
  const start = MAGIC.length + HEADER_LENGTH_BYTES;
  const end = start + headerLength;
  if (headerLength < 2 || end >= bytes.length) throw new Error('Encrypted backup header is incomplete.');
  const header = JSON.parse(decoder.decode(bytes.subarray(start, end))) as EncryptedEnvelopeHeader;
  if (header.version !== 1 || header.cipher !== 'AES-256-GCM' || header.kdf !== 'PBKDF2-SHA-256') {
    throw new Error('Encrypted backup version is not supported.');
  }
  return header;
};

const contextFromPassphrase = async (header: EncryptedEnvelopeHeader, passphrase: string): Promise<StoredEncryptionContext> => {
  validatePassphrase(passphrase);
  try {
    const wrappingKey = await deriveWrappingKey(passphrase, base64ToBytes(header.salt), header.iterations);
    const masterKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(header.wrapNonce),
        additionalData: wrapAdditionalData(header.keyId),
      },
      wrappingKey,
      base64ToBytes(header.wrappedKey),
    ));
    return {
      keyId: header.keyId,
      masterKey: bytesToBase64(masterKey),
      salt: header.salt,
      wrapNonce: header.wrapNonce,
      wrappedKey: header.wrappedKey,
      iterations: header.iterations,
    };
  } catch {
    throw new Error('Backup passphrase is incorrect or the encrypted key is damaged.');
  }
};

const decodeEnvelopeWithContext = async (
  bytes: Uint8Array,
  header: EncryptedEnvelopeHeader,
  context: StoredEncryptionContext,
): Promise<Uint8Array> => {
  if (context.keyId !== header.keyId) throw new Error('The stored backup key does not match this archive.');
  const start = MAGIC.length + HEADER_LENGTH_BYTES;
  const headerBytes = encoder.encode(JSON.stringify(header));
  const ciphertext = bytes.subarray(start + headerBytes.length);
  try {
    const masterKey = await importMasterKey(base64ToBytes(context.masterKey));
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(header.dataNonce), additionalData: headerBytes },
      masterKey,
      ciphertext,
    ));
  } catch {
    throw new Error('Encrypted backup authentication failed. The file may be corrupted or modified.');
  }
};

export const encryptBackupWithPassphrase = async (payload: Uint8Array, passphrase: string): Promise<Uint8Array> => (
  encodeEnvelope(payload, await createContext(passphrase))
);

export const decryptBackupWithPassphrase = async (bytes: Uint8Array, passphrase: string): Promise<Uint8Array> => {
  const header = inspectEncryptedEnvelope(bytes);
  const context = await contextFromPassphrase(header, passphrase);
  return decodeEnvelopeWithContext(bytes, header, context);
};

const secureKey = (accountId: string): string => `${CONTEXT_KEY_PREFIX}${accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const prepareSecureStorage = async (): Promise<void> => {
  await SecureStorage.setKeyPrefix(SECURE_STORAGE_PREFIX);
};

const saveContext = async (accountId: string, context: StoredEncryptionContext): Promise<void> => {
  await prepareSecureStorage();
  await SecureStorage.setItem(secureKey(accountId), JSON.stringify(context));
};

const loadContext = async (accountId: string): Promise<StoredEncryptionContext | null> => {
  await prepareSecureStorage();
  const value = await SecureStorage.getItem(secureKey(accountId));
  if (!value) return null;
  try { return JSON.parse(value) as StoredEncryptionContext; } catch { return null; }
};

export const configureDriveEncryption = async (accountId: string, passphrase: string): Promise<string> => {
  const context = await createContext(passphrase);
  await saveContext(accountId, context);
  return context.keyId;
};

export const disableDriveEncryption = async (accountId: string): Promise<void> => {
  await prepareSecureStorage();
  await SecureStorage.removeItem(secureKey(accountId));
};

export const encryptWithStoredDriveKey = async (payload: Uint8Array, accountId: string): Promise<Uint8Array> => {
  const context = await loadContext(accountId);
  if (!context) throw new Error('Drive encryption is enabled, but this device no longer has its secure backup key. Re-enter the passphrase.');
  return encodeEnvelope(payload, context);
};

export const decryptDriveEnvelope = async (
  bytes: Uint8Array,
  accountId: string,
  passphrase?: string,
): Promise<Uint8Array> => {
  const header = inspectEncryptedEnvelope(bytes);
  let context = await loadContext(accountId);
  if (!context || context.keyId !== header.keyId) {
    if (!passphrase) throw new Error('PASSPHRASE_REQUIRED');
    context = await contextFromPassphrase(header, passphrase);
    await saveContext(accountId, context);
  }
  return decodeEnvelopeWithContext(bytes, header, context);
};

export const changeDriveEncryptionPassphrase = async (
  accountId: string,
  currentPassphrase: string,
  newPassphrase: string,
): Promise<string> => {
  validatePassphrase(newPassphrase);
  const current = await loadContext(accountId);
  if (!current) throw new Error('No Drive encryption key is stored on this device.');
  const wrappingKey = await deriveWrappingKey(currentPassphrase, base64ToBytes(current.salt), current.iterations);
  let unwrapped: Uint8Array;
  try {
    unwrapped = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(current.wrapNonce), additionalData: wrapAdditionalData(current.keyId) },
      wrappingKey,
      base64ToBytes(current.wrappedKey),
    ));
  } catch {
    throw new Error('Current backup passphrase is incorrect.');
  }
  if (!equalBytes(unwrapped, base64ToBytes(current.masterKey))) throw new Error('Stored backup key validation failed.');
  const salt = randomBytes(16);
  const wrapNonce = randomBytes(12);
  const nextWrappingKey = await deriveWrappingKey(newPassphrase, salt, BACKUP_KDF_ITERATIONS);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapNonce, additionalData: wrapAdditionalData(current.keyId) },
    nextWrappingKey,
    unwrapped,
  ));
  await saveContext(accountId, {
    ...current,
    salt: bytesToBase64(salt),
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedKey: bytesToBase64(wrappedKey),
    iterations: BACKUP_KDF_ITERATIONS,
  });
  return current.keyId;
};
