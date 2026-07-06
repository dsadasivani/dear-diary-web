import type { CompanionKeyPackage } from '../types';
import { ACCOUNT_ROOT_KEY_BYTES } from './e2eeKeyPackage';
import {
  fingerprintDevicePublicKey,
  parseDevicePrivateKeyBundle,
  parseDevicePublicKeyBundle,
} from './deviceKeys';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HKDF_INFO = encoder.encode('dear-diary/companion-root-key/v1');

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = typeof atob === 'function' ? atob(value) : Buffer.from(value, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const deriveWrappingKey = async (
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

export const wrapRootKeyForCompanion = async (
  accountRootKey: Uint8Array,
  accountId: string,
  targetDevicePublicKey: string,
): Promise<CompanionKeyPackage> => {
  if (accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Account root key length is invalid.');
  const targetBundle = parseDevicePublicKeyBundle(targetDevicePublicKey);
  const targetPublicKey = await crypto.subtle.importKey(
    'jwk', targetBundle.encryption, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await deriveWrappingKey(senderPair.privateKey, targetPublicKey, salt);
  const senderEphemeralPublicKey = await crypto.subtle.exportKey('jwk', senderPair.publicKey);
  const targetDevicePublicKeySha256 = await fingerprintDevicePublicKey(targetDevicePublicKey);
  const additionalData = encoder.encode(`${accountId}:${targetDevicePublicKeySha256}`);
  const wrappedRootKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData }, wrappingKey, accountRootKey,
  ));
  return {
    version: 1,
    packageKind: 'companion_root_key',
    cipher: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    accountId,
    targetDevicePublicKeySha256,
    senderEphemeralPublicKey,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    wrappedRootKey: bytesToBase64(wrappedRootKey),
    createdAt: new Date().toISOString(),
  };
};

export const unwrapRootKeyForCompanion = async (
  keyPackage: CompanionKeyPackage,
  targetDevicePublicKey: string,
  targetDevicePrivateKey: string,
): Promise<Uint8Array> => {
  if (
    keyPackage.version !== 1 ||
    keyPackage.packageKind !== 'companion_root_key' ||
    keyPackage.cipher !== 'AES-256-GCM' ||
    keyPackage.kdf !== 'HKDF-SHA-256'
  ) throw new Error('Companion key package is invalid or unsupported.');
  const fingerprint = await fingerprintDevicePublicKey(targetDevicePublicKey);
  if (fingerprint !== keyPackage.targetDevicePublicKeySha256) {
    throw new Error('Companion key package targets another device.');
  }
  const privateBundle = parseDevicePrivateKeyBundle(targetDevicePrivateKey);
  const privateKey = await crypto.subtle.importKey(
    'jwk', privateBundle.encryption, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
  );
  const senderPublicKey = await crypto.subtle.importKey(
    'jwk', keyPackage.senderEphemeralPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const wrappingKey = await deriveWrappingKey(privateKey, senderPublicKey, base64ToBytes(keyPackage.salt));
  try {
    const rootKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(keyPackage.nonce),
        additionalData: encoder.encode(`${keyPackage.accountId}:${fingerprint}`),
      },
      wrappingKey,
      base64ToBytes(keyPackage.wrappedRootKey),
    ));
    if (rootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Invalid root key length.');
    return rootKey;
  } catch {
    throw new Error('Companion key package authentication failed.');
  }
};

export const encodeCompanionKeyPackage = (keyPackage: CompanionKeyPackage): Uint8Array => (
  encoder.encode(JSON.stringify(keyPackage))
);

export const decodeCompanionKeyPackage = (bytes: Uint8Array): CompanionKeyPackage => (
  JSON.parse(decoder.decode(bytes)) as CompanionKeyPackage
);
