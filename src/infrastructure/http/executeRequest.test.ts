import assert from 'node:assert/strict';
import test from 'node:test';
import { mapSupabaseError } from '../../sync/errors';
import { executeRequest } from './executeRequest';

test('retries retryable responses and preserves a correlation identifier', async () => {
  const correlations: string[] = [];
  let attempts = 0;
  const response = await executeRequest({
    request: async ({ correlationId }) => {
      correlations.push(correlationId);
      attempts += 1;
      return new Response('', { status: attempts === 1 ? 503 : 200 });
    },
    mapError: mapSupabaseError,
    retryPolicy: { maxAttempts: 2 },
    random: () => 0,
    sleep: async () => undefined,
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(new Set(correlations).size, 1);
});

test('does not retry non-retryable authorization failures', async () => {
  let attempts = 0;
  await assert.rejects(
    executeRequest({
      request: async () => {
        attempts += 1;
        return new Response('', { status: 401 });
      },
      mapError: mapSupabaseError,
      sleep: async () => undefined,
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'AUTH_EXPIRED',
  );
  assert.equal(attempts, 1);
});
