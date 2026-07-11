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
  options: { keyEpoch?: number; accountRootKeys?: Record<number, Uint8Array> } = {},
): Promise<CompanionKeyPackage> => {
  if (accountRootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Account root key length is invalid.');
  Object.entries(options.accountRootKeys || {}).forEach(([epoch, key]) => {
    if (!Number.isInteger(Number(epoch)) || Number(epoch) < 1 || key.byteLength !== ACCOUNT_ROOT_KEY_BYTES) {
      throw new Error('Epoch root key metadata is invalid.');
    }
  });
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
  const keyEpoch = options.keyEpoch || 1;
  const wrapEpochRootKey = async (epoch: number, rootKey: Uint8Array, fixedNonce?: Uint8Array) => {
    const epochNonce = fixedNonce || crypto.getRandomValues(new Uint8Array(12));
    const additionalData = encoder.encode(`${accountId}:${targetDevicePublicKeySha256}:${epoch}`);
    const wrappedRootKey = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: epochNonce, additionalData }, wrappingKey, rootKey,
    ));
    return {
      keyEpoch: epoch,
      nonce: bytesToBase64(epochNonce),
      wrappedRootKey: bytesToBase64(wrappedRootKey),
    };
  };
  const primaryWrapped = await wrapEpochRootKey(keyEpoch, accountRootKey, nonce);
  const epochRootKeys = Object.entries({
    ...(options.accountRootKeys || {}),
    [keyEpoch]: accountRootKey,
  })
    .map(([epoch, key]) => ({ keyEpoch: Number(epoch), rootKey: key }))
    .filter(entry => Number.isInteger(entry.keyEpoch) && entry.keyEpoch > 0)
    .sort((left, right) => left.keyEpoch - right.keyEpoch);
  const wrappedEpochRootKeys = options.accountRootKeys
    ? await Promise.all(epochRootKeys.map(entry => wrapEpochRootKey(entry.keyEpoch, entry.rootKey)))
    : undefined;
  return {
    version: 1,
    packageKind: 'companion_root_key',
    cipher: 'AES-256-GCM',
    kdf: 'HKDF-SHA-256',
    accountId,
    keyEpoch,
    targetDevicePublicKeySha256,
    senderEphemeralPublicKey,
    salt: bytesToBase64(salt),
    nonce: primaryWrapped.nonce,
    wrappedRootKey: primaryWrapped.wrappedRootKey,
    wrappedEpochRootKeys,
    createdAt: new Date().toISOString(),
  };
};

export const unwrapRootKeysForCompanion = async (
  keyPackage: CompanionKeyPackage,
  targetDevicePublicKey: string,
  targetDevicePrivateKey: string,
): Promise<{ keyEpoch: number; accountRootKey: Uint8Array; accountRootKeys: Record<number, Uint8Array> }> => {
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
  const unwrapEpochRootKey = async (keyEpoch: number, nonce: string, wrappedRootKey: string): Promise<Uint8Array> => {
    if (!Number.isInteger(keyEpoch) || keyEpoch < 1) throw new Error('Companion key package epoch is invalid.');
    const rootKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(nonce),
        additionalData: encoder.encode(`${keyPackage.accountId}:${fingerprint}:${keyEpoch}`),
      },
      wrappingKey,
      base64ToBytes(wrappedRootKey),
    ));
    if (rootKey.byteLength !== ACCOUNT_ROOT_KEY_BYTES) throw new Error('Invalid root key length.');
    return rootKey;
  };
  try {
    const keyEpoch = keyPackage.keyEpoch || 1;
    const accountRootKey = await unwrapEpochRootKey(
      keyEpoch,
      keyPackage.nonce,
      keyPackage.wrappedRootKey,
    );
    const accountRootKeys: Record<number, Uint8Array> = { [keyEpoch]: accountRootKey };
    for (const wrapped of keyPackage.wrappedEpochRootKeys || []) {
      accountRootKeys[wrapped.keyEpoch] = await unwrapEpochRootKey(
        wrapped.keyEpoch,
        wrapped.nonce,
        wrapped.wrappedRootKey,
      );
    }
    return {
      keyEpoch,
      accountRootKey: accountRootKeys[keyEpoch] || accountRootKey,
      accountRootKeys,
    };
  } catch {
    throw new Error('Companion key package authentication failed.');
  }
};

export const unwrapRootKeyForCompanion = async (
  keyPackage: CompanionKeyPackage,
  targetDevicePublicKey: string,
  targetDevicePrivateKey: string,
): Promise<Uint8Array> => (
  (await unwrapRootKeysForCompanion(keyPackage, targetDevicePublicKey, targetDevicePrivateKey)).accountRootKey
);

export const encodeCompanionKeyPackage = (keyPackage: CompanionKeyPackage): Uint8Array => (
  encoder.encode(JSON.stringify(keyPackage))
);

export const decodeCompanionKeyPackage = (bytes: Uint8Array): CompanionKeyPackage => (
  JSON.parse(decoder.decode(bytes)) as CompanionKeyPackage
);
