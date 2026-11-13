import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCard, parseBoard, parseTodo, renderBoard, renderTodo, toggleItem } from '../../src/page-list.ts';

const TODO = `Ship the Prints PR.

## Today
- [ ] Write the tests
- [x] Read the docs
* [ ] Ask **Mike** about [the reminder](https://example.com)

## Later
- [ ] Recipes PR
`;

test('todo: items in order, under their headings, with what they say', () => {
  const t = parseTodo(TODO);
  assert.deepEqual(t.items.map((i) => [i.n, i.done, i.text, i.group]), [
    [0, false, 'Write the tests', 'Today'],
    [1, true, 'Read the docs', 'Today'],
    [2, false, 'Ask **Mike** about [the reminder](https://example.com)', 'Today'],
    [3, false, 'Recipes PR', 'Later'],
  ]);
  assert.equal(t.done, 1);
});

test('todo: ticking flips one box and leaves every other byte alone', () => {
  const once = toggleItem(TODO, 0);
  assert.match(once, /- \[x\] Write the tests/);
  assert.equal(once.replace('- [x] Write the tests', '- [ ] Write the tests'), TODO);
  assert.match(toggleItem(TODO, 1), /- \[ \] Read the docs/);
  assert.match(toggleItem(TODO, 2), /^\* \[x\] Ask/m, 'its own bullet is kept');
  assert.throws(() => toggleItem(TODO, 9), /no item 9/);
});

test('todo page: each box is a link back to the app with the version, links in text are flattened, nothing runs', () => {
  const html = renderTodo('Launch', TODO, 'Version 3', 3);
  assert.match(html, /href="threadbear-print:toggle\?v=3&amp;item=0"/);
  assert.match(html, /class="item done"[^>]*href="threadbear-print:toggle\?v=3&amp;item=1"/);
  assert.match(html, /1 of 4 done/);
  assert.match(html, /<h2>Today<\/h2>/);
  assert.match(html, /<strong>Mike<\/strong> about the reminder/, 'no link inside a link');
  assert.doesNotMatch(html, /<script|\son\w+=/i);
  assert.match(renderTodo('<x>', '- [ ] <b>hi</b>', 'v', 1), /&lt;b&gt;hi&lt;\/b&gt;/);
});

const BOARD = `## To do
- Write the tests
- [ ] Draft the PR body

## Doing
- Port the Prints work

## Done
- [x] Read the docs
`;

test('board: columns from headings, cards from list items', () => {
  const b = parseBoard(BOARD);
  assert.deepEqual(b.columns.map((c) => [c.name, c.cards.map((x) => [x.n, x.text])]), [
    ['To do', [[0, 'Write the tests'], [1, 'Draft the PR body']]],
    ['Doing', [[2, 'Port the Prints work']]],
    ['Done', [[3, 'Read the docs']]],
  ]);
});

test('board: moving a card puts it at the end of its new column and keeps its line as written', () => {
  const moved = moveCard(BOARD, 0, 1);
  const b = parseBoard(moved);
  assert.deepEqual(b.columns.map((c) => c.cards.map((x) => x.text)), [['Draft the PR body'], ['Port the Prints work', 'Write the tests'], ['Read the docs']]);
  assert.match(moved, /## Doing\n- Port the Prints work\n- Write the tests\n/);
  const toEmpty = moveCard('## A\n- one\n\n## B\n', 0, 1);
  assert.deepEqual(parseBoard(toEmpty).columns.map((c) => c.cards.map((x) => x.text)), [[], ['one']]);
  assert.equal(moveCard(BOARD, 2, 1), BOARD, 'to its own column: nothing changes');
  assert.throws(() => moveCard(BOARD, 9, 0), /no card 9/);
  assert.throws(() => moveCard(BOARD, 0, 7), /no column 7/);
});

test('board page: each card can go one column left or right, by link, and nothing runs', () => {
  const html = renderBoard('Prints', BOARD, 'Version 2', 2);
  assert.match(html, /href="threadbear-print:move\?v=2&amp;card=0&amp;to=1"/, 'To do card moves right to Doing');
  assert.match(html, /href="threadbear-print:move\?v=2&amp;card=2&amp;to=0"/, 'Doing card moves left to To do');
  assert.match(html, /href="threadbear-print:move\?v=2&amp;card=2&amp;to=2"/);
  assert.doesNotMatch(html, /card=0&amp;to=-1|card=3&amp;to=3/, 'no move off either end');
  assert.match(html, /<h2>To do <span class="count">2<\/span><\/h2>/);
  assert.doesNotMatch(html, /<script|\son\w+=/i);
});
