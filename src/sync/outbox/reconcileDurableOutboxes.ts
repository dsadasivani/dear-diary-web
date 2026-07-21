import type { DiaryRepository } from '../../repositories/DiaryRepository';
import type { OutboxRepository } from './OutboxRepository';
import { pendingOutboxV2FromLegacy } from './legacyOutboxV2';
import { TERMINAL_OUTBOX_V2_STATES } from './SyncOutboxOperationV2';

type LegacyOutboxRepository = Pick<
  DiaryRepository,
  'listSyncOutboxOperations' | 'removeSyncOutboxOperation'
>;

/**
 * Reconciles the two durable outbox representations before workers start.
 *
 * V2 terminal rows are authoritative and allow their legacy compatibility row
 * to be removed. A legacy row without a V2 counterpart represents an
 * interrupted or previously raced mirror write, so it is safe to reconstruct
 * the payload-free V2 envelope from the durable legacy operation.
 */
export const reconcileDurableOutboxes = async (
  legacy: LegacyOutboxRepository,
  v2: OutboxRepository,
): Promise<void> => {
  for (const operation of await legacy.listSyncOutboxOperations()) {
    const v2Operation = await v2.getById(operation.operationId);
    if (v2Operation && TERMINAL_OUTBOX_V2_STATES.has(v2Operation.state)) {
      await legacy.removeSyncOutboxOperation(operation.operationId);
      continue;
    }
    if (!v2Operation) await v2.enqueue(pendingOutboxV2FromLegacy(operation));
  }
};
