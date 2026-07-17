import type { LocalDataStore } from '../../../platform/storage';
import type { LocalSyncAccountState } from '../../../types';
import type { OutboxRepository } from '../../outbox';
import { PersistentSafetyStopStore } from './PersistentSafetyStopStore';

/**
 * A companion that has not applied a single remote event can safely retry a
 * stopped initial pull, provided it has no local writes waiting to upload.
 * The pull itself remains the verification step: any real integrity failure
 * immediately engages the persistent safety stop again.
 */
export const clearRecoverableCompanionSafetyStop = async (
  store: LocalDataStore,
  outbox: OutboxRepository,
  account: LocalSyncAccountState,
): Promise<boolean> => {
  if (account.deviceRole !== 'web_companion') return false;
  const runtimeRaw = await store.getItem('deardiary_sync_v2_runtime');
  if (!runtimeRaw) return false;
  const runtime = JSON.parse(runtimeRaw) as { accountId?: string; lastAppliedSequence?: number };
  if (runtime.accountId !== account.accountId || runtime.lastAppliedSequence !== 0) return false;

  const safety = new PersistentSafetyStopStore(store);
  if (!await safety.get(account.accountId)) return false;
  const pendingLocalWrites = (await outbox.listByAccount(account.accountId))
    .some(operation => operation.state !== 'ACKNOWLEDGED' && operation.state !== 'SUPERSEDED');
  if (pendingLocalWrites) return false;

  await safety.clearAfterVerifiedRecovery(account.accountId);
  return true;
};
