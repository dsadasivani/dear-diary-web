import {
  decryptSyncPayload,
  encryptSyncPayload,
  readEncryptedSyncObjectHeader,
} from '../../encryptedSyncObject';
import { SyncError } from '../../errors';

export interface SyncV2SnapshotCodec {
  encrypt(payload: Uint8Array, keyEpoch: number): Promise<Uint8Array>;
  decrypt(bytes: Uint8Array, keyEpoch: number): Promise<Uint8Array>;
}

export class AccountKeySyncV2SnapshotCodec implements SyncV2SnapshotCodec {
  constructor(private readonly keyForEpoch: (keyEpoch: number) => Promise<Uint8Array>) {}

  async encrypt(payload: Uint8Array, keyEpoch: number): Promise<Uint8Array> {
    const encrypted = await encryptSyncPayload(
      await this.keyForEpoch(keyEpoch),
      'snapshot',
      payload,
      { keyEpoch },
    );
    return encrypted.bytes;
  }

  async decrypt(bytes: Uint8Array, keyEpoch: number): Promise<Uint8Array> {
    try {
      const header = readEncryptedSyncObjectHeader(bytes);
      if (!header || header.objectKind !== 'snapshot' || header.keyEpoch !== keyEpoch) {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      const decrypted = await decryptSyncPayload(await this.keyForEpoch(keyEpoch), bytes);
      if (decrypted.objectKind !== 'snapshot') {
        throw new SyncError({ code: 'INVARIANT_VIOLATION', safetyRelevant: true });
      }
      return decrypted.payload;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError({ code: 'DECRYPTION_FAILED', safetyRelevant: true, cause: error });
    }
  }
}
