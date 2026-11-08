// The profile page's activity grid (profile.tsx): weeks start on Sunday,
// and a day's shade is against the busiest day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { level, weeks } from './profile-grid.ts';

test('weeks are columns of seven, the first padded to its Sunday', () => {
  // 2026-11-04 is a Wednesday.
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((date) => ({ date, count: 1 }));
  const cols = weeks(days);
  assert.equal(cols.length, 2);
  assert.deepEqual(cols[0]!.slice(0, 3), [null, null, null]);
  assert.equal(cols[0]![3]!.date, '2026-11-04');
  assert.equal(cols[1]![0]!.date, '2026-11-08');
});

test('levels: none for no threads, 1 to 4 by share of the busiest day', () => {
  assert.equal(level(0, 10), 0);
  assert.equal(level(1, 10), 1);
  assert.equal(level(5, 10), 2);
  assert.equal(level(10, 10), 4);
  assert.equal(level(3, 0), 0);
});
