// node --test web/src/print-fence.test.ts
// The same cases as the Mac's PageFenceTests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrintId, printFenceId, printLabel } from './print-fence.ts';

test('a print block names its id in the info string or as its first word', () => {
  assert.equal(printFenceId('```print pg_sales\n```'), 'pg_sales');
  assert.equal(printFenceId('```page pg_old_name\n```'), 'pg_old_name', 'the old name still draws');
  assert.equal(printFenceId('```Print pg_sales\n```'), 'pg_sales');
  assert.equal(printFenceId('```print\npg_body_id\n```'), 'pg_body_id');
  assert.equal(printFenceId('~~~print pg_tilde\n~~~'), 'pg_tilde');
});

test('anything else is not a print block', () => {
  for (const s of ['```ts\nconst a = 1\n```', '```print\n```', '```print not_an_id\n```', '```print pg_Bad\n```', '```printer pg_a\n```', '', 'plain text']) {
    assert.equal(printFenceId(s), undefined, s);
  }
  assert.ok(!isPrintId('pg_'));
  assert.ok(!isPrintId(`pg_${'a'.repeat(80)}`));
});

test('labels match the Mac', () => {
  assert.equal(printLabel('page'), 'Print');
  assert.equal(printLabel('dashboard'), 'Dashboard');
});
