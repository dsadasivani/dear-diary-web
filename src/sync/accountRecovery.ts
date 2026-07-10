import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import {
  decodeRecoveryKeyPackage,
  unwrapAccountRootKeysFromRecovery,
} from './e2eeKeyPackage';
import {
  downloadVerifiedSyncObject,
  type SyncObjectDownloader,
} from './eventReplay';

export const recoverAccountRootKey = async (input: {
  objects: SyncObjectMetadata[];
  accountId: string;
  recoveryPassphrase: string;
  googleSession: GoogleAccountSession;
  download?: SyncObjectDownloader;
}): Promise<{
  accountRootKey: Uint8Array;
  accountRootKeys: Record<number, Uint8Array>;
  object: SyncObjectMetadata;
}> => {
  const candidates = input.objects
    .filter(object => object.objectKind === 'key_package')
    .sort((left, right) => right.sequence - left.sequence);
  if (candidates.length === 0) throw new Error('No recovery key package was found for this account.');

  let latest: { accountRootKey: Uint8Array; object: SyncObjectMetadata } | null = null;
  const accountRootKeys: Record<number, Uint8Array> = {};
  for (const object of candidates) {
    try {
      const bytes = await downloadVerifiedSyncObject(input.googleSession, object, input.download);
      const keyPackage = decodeRecoveryKeyPackage(bytes);
      if (keyPackage.accountId && keyPackage.accountId !== input.accountId) continue;
      const unwrapped = await unwrapAccountRootKeysFromRecovery(keyPackage, input.recoveryPassphrase);
      const packageEpoch = keyPackage.keyEpoch || object.keyEpoch || 1;
      accountRootKeys[packageEpoch] = unwrapped.accountRootKeys[keyPackage.keyEpoch || 1] || unwrapped.accountRootKey;
      Object.entries(unwrapped.accountRootKeys).forEach(([epoch, rootKey]) => {
        accountRootKeys[Number(epoch)] = rootKey;
      });
      latest ??= {
        accountRootKey: accountRootKeys[packageEpoch] || unwrapped.accountRootKey,
        object,
      };
    } catch {
      // Companion packages and damaged/obsolete recovery packages are skipped.
    }
  }
  if (!latest) throw new Error('Recovery passphrase is incorrect or no valid root-key package remains.');
  return {
    accountRootKey: latest.accountRootKey,
    accountRootKeys,
    object: latest.object,
  };
};
