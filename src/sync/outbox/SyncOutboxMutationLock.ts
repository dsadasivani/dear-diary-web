import type { LocalDataStore } from '../../platform/storage';

const mutationTails = new WeakMap<LocalDataStore, Promise<void>>();

/**
 * Serializes every in-process read-modify-write of the shared operation ledger.
 *
 * The diary repository and worker use separate repository classes, but both
 * persist `deardiary_sync_operations`. Without a shared lock,
 * either writer can read an old snapshot and overwrite an operation written by
 * the other one.
 */
export const withSyncOutboxMutationLock = <T>(
  store: LocalDataStore,
  mutation: () => Promise<T>,
): Promise<T> => {
  const previous = mutationTails.get(store) || Promise.resolve();
  const result = previous.then(mutation, mutation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(store, tail);
  void tail.finally(() => {
    if (mutationTails.get(store) === tail) mutationTails.delete(store);
  });
  return result;
};
