import type { DevicePrivateKeyBundle, DevicePublicKeyBundle } from '../types';

const encoder = new TextEncoder();

export interface GeneratedDeviceKeyPair {
  publicKey: string;
  privateKey: CryptoKey;
  privateKeyJwk: string;
  encryptionPrivateKey: CryptoKey;
}

export const generateDeviceKeyPair = async (): Promise<GeneratedDeviceKeyPair> => {
  const signingPair = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );
  const encryptionPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const signingPublicJwk = await crypto.subtle.exportKey('jwk', signingPair.publicKey);
  const signingPrivateJwk = await crypto.subtle.exportKey('jwk', signingPair.privateKey);
  const encryptionPublicJwk = await crypto.subtle.exportKey('jwk', encryptionPair.publicKey);
  const encryptionPrivateJwk = await crypto.subtle.exportKey('jwk', encryptionPair.privateKey);
  const publicBundle: DevicePublicKeyBundle = {
    version: 1,
    signing: { ...signingPublicJwk, alg: 'ES256', use: 'sig' },
    encryption: encryptionPublicJwk,
  };
  const privateBundle: DevicePrivateKeyBundle = {
    version: 1,
    signing: signingPrivateJwk,
    encryption: encryptionPrivateJwk,
  };
  return {
    publicKey: JSON.stringify(publicBundle),
    privateKey: signingPair.privateKey,
    privateKeyJwk: JSON.stringify(privateBundle),
    encryptionPrivateKey: encryptionPair.privateKey,
  };
};

export const parseDevicePublicKeyBundle = (value: string): DevicePublicKeyBundle => {
  const bundle = JSON.parse(value) as DevicePublicKeyBundle;
  if (
    bundle.version !== 1 ||
    bundle.signing?.kty !== 'EC' ||
    bundle.signing?.crv !== 'P-256' ||
    bundle.encryption?.kty !== 'EC' ||
    bundle.encryption?.crv !== 'P-256'
  ) {
    throw new Error('Device public key bundle is invalid or unsupported.');
  }
  return bundle;
};

export const parseDevicePrivateKeyBundle = (value: string): DevicePrivateKeyBundle => {
  const bundle = JSON.parse(value) as DevicePrivateKeyBundle;
  if (
    bundle.version !== 1 ||
    bundle.signing?.kty !== 'EC' ||
    !bundle.signing?.d ||
    bundle.encryption?.kty !== 'EC' ||
    !bundle.encryption?.d
  ) {
    throw new Error('Device private key bundle is invalid or unsupported.');
  }
  return bundle;
};

export const exportDeviceSigningPublicKeySpki = async (
  publicKeyBundle: string,
): Promise<string> => {
  const bundle = parseDevicePublicKeyBundle(publicKeyBundle);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    bundle.signing,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  let binary = '';
  spki.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

export const fingerprintDevicePublicKey = async (publicKey: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(publicKey));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};
