import type { GoogleAccountSession, SyncObjectMetadata } from '../types';
import {
  decodeRecoveryKeyPackage,
  unwrapAccountRootKeyFromRecovery,
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
}): Promise<{ accountRootKey: Uint8Array; object: SyncObjectMetadata }> => {
  const candidates = input.objects
    .filter(object => object.objectKind === 'key_package')
    .sort((left, right) => right.sequence - left.sequence);
  if (candidates.length === 0) throw new Error('No recovery key package was found for this account.');

  for (const object of candidates) {
    try {
      const bytes = await downloadVerifiedSyncObject(input.googleSession, object, input.download);
      const keyPackage = decodeRecoveryKeyPackage(bytes);
      if (keyPackage.accountId && keyPackage.accountId !== input.accountId) continue;
      return {
        accountRootKey: await unwrapAccountRootKeyFromRecovery(keyPackage, input.recoveryPassphrase),
        object,
      };
    } catch {
      // Companion packages and damaged/obsolete recovery packages are skipped.
    }
  }
  throw new Error('Recovery passphrase is incorrect or no valid root-key package remains.');
};
