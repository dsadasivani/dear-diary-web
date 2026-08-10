import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncError } from '../errors';
import {
  ALLOWED_SYNC_OPERATION_TRANSITIONS,
  assertAllowedOutboxTransition,
  isAllowedOutboxTransition,
} from './OutboxStateMachine';
import { SYNC_OPERATION_STATES } from './SyncOperation';

test('accepts every declared outbox transition and rejects every undeclared transition', () => {
  for (const from of SYNC_OPERATION_STATES) {
    for (const to of SYNC_OPERATION_STATES) {
      const declared = ALLOWED_SYNC_OPERATION_TRANSITIONS[from].has(to);
      assert.equal(isAllowedOutboxTransition(from, to), declared, `${from} -> ${to}`);
      if (declared) assert.doesNotThrow(() => assertAllowedOutboxTransition(from, to));
      else
        assert.throws(
          () => assertAllowedOutboxTransition(from, to),
          (error: unknown) => error instanceof SyncError && error.code === 'INVARIANT_VIOLATION',
        );
    }
  }
});
