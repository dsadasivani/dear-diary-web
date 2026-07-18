import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncError } from '../errors';
import {
  ALLOWED_OUTBOX_V2_TRANSITIONS,
  assertAllowedOutboxTransition,
  isAllowedOutboxTransition,
} from './OutboxStateMachine';
import { OUTBOX_V2_STATES } from './SyncOutboxOperationV2';

test('accepts every declared outbox transition and rejects every undeclared transition', () => {
  for (const from of OUTBOX_V2_STATES) {
    for (const to of OUTBOX_V2_STATES) {
      const declared = ALLOWED_OUTBOX_V2_TRANSITIONS[from].has(to);
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
