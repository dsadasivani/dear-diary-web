import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateLocalStreak,
  fromLocalDateKey,
  getLocalDayRange,
  isLocalDateKey,
  toLocalDateKey,
} from './localDate';

test('local date keys honor positive and negative timezone calendar days', () => {
  const instant = new Date('2026-01-01T20:15:00.000Z');
  assert.equal(toLocalDateKey(instant, 'Asia/Kolkata'), '2026-01-02');
  assert.equal(toLocalDateKey(instant, 'UTC'), '2026-01-01');
  assert.equal(
    toLocalDateKey(new Date('2026-01-01T02:00:00.000Z'), 'America/Los_Angeles'),
    '2025-12-31',
  );
});

test('local date keys remain stable across a daylight-saving boundary', () => {
  assert.equal(
    toLocalDateKey(new Date('2026-03-08T09:59:00.000Z'), 'America/Los_Angeles'),
    '2026-03-08',
  );
  assert.equal(
    toLocalDateKey(new Date('2026-03-08T10:01:00.000Z'), 'America/Los_Angeles'),
    '2026-03-08',
  );
});

test('local date parsing validates month and year transitions', () => {
  assert.equal(isLocalDateKey('2026-02-29'), false);
  assert.equal(isLocalDateKey('2024-02-29'), true);
  const parsed = fromLocalDateKey('2026-12-31');
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 11);
  assert.equal(parsed.getDate(), 31);
});

test('local day ranges use the next local midnight instead of a fixed UTC duration', () => {
  const { start, end } = getLocalDayRange(new Date(2026, 2, 8, 23, 59));
  assert.equal(toLocalDateKey(start), '2026-03-08');
  assert.equal(toLocalDateKey(end), '2026-03-09');
});

test('local streaks include today or fall back to yesterday', () => {
  const today = new Date(2026, 0, 3, 0, 1);
  assert.equal(calculateLocalStreak(['2026-01-01', '2026-01-02', '2026-01-03'], today), 3);
  assert.equal(calculateLocalStreak(['2026-01-01', '2026-01-02'], today), 2);
});
