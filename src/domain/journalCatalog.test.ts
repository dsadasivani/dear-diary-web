import assert from 'node:assert/strict';
import test from 'node:test';
import { getTodayWordCount, recordPositiveDailyWordDelta } from './journalCatalog';

const today = new Date(2026, 7, 7, 12);

test('tracks positive additions independently of the entry date', () => {
  const created = recordPositiveDailyWordDelta(null, 12, today);
  const expanded = recordPositiveDailyWordDelta(
    { wordCount: 12, wordsWrittenByDate: created },
    18,
    today,
  );
  const shortened = recordPositiveDailyWordDelta(
    { wordCount: 18, wordsWrittenByDate: expanded },
    4,
    today,
  );

  assert.deepEqual(shortened, { '2026-08-07': 18 });
  assert.equal(getTodayWordCount([{ wordsWrittenByDate: shortened }], today), 18);
});

test('starts a separate bucket after local midnight and treats legacy entries as zero', () => {
  const activity = recordPositiveDailyWordDelta(
    { wordCount: 4, wordsWrittenByDate: { '2026-08-07': 4 } },
    7,
    new Date(2026, 7, 8, 0, 1),
  );

  assert.deepEqual(activity, { '2026-08-07': 4, '2026-08-08': 3 });
  assert.equal(getTodayWordCount([{ wordsWrittenByDate: undefined }], today), 0);
});
