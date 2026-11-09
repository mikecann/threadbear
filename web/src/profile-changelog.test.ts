// The profile page's changelog (profile-changelog.ts): what's read from
// GitHub's answer, how it's grouped, and what's said when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byDay, commitsUrl, hasNext, readCommits, splitSubject, trouble } from './profile-changelog.ts';

const commit = (sha: string, message: string, date: string, parents = 1) => ({
  sha,
  html_url: `https://github.com/waynesutton/threadbear/commit/${sha}`,
  parents: Array.from({ length: parents }, () => ({ sha: 'p' })),
  commit: { message, author: { date } },
});

test('the area is a short plain prefix before a colon', () => {
  assert.deepEqual(splitSubject('Profile page: its addresses as two rows'), { area: 'Profile page', text: 'Its addresses as two rows' });
  assert.deepEqual(splitSubject('⌘/ collapses the Threads panel'), { text: '⌘/ collapses the Threads panel' });
  assert.deepEqual(splitSubject('See https://example.com for more'), { text: 'See https://example.com for more' });
  assert.deepEqual(splitSubject('A very long subject that is really a sentence: and then more'), { text: 'A very long subject that is really a sentence: and then more' });
});

test('commits: merges, trailers and anything malformed are left out', () => {
  const changes = readCommits([
    commit('aaaaaaa1', 'Customize: a fix\n\nWhy it was broken.\n\nCo-Authored-By: Claude <noreply@anthropic.com>', '2026-11-09T12:00:00Z'),
    commit('bbbbbbb2', "Merge branch 'main'", '2026-11-09T12:00:00Z', 2),
    { sha: 'not-a-sha', html_url: 'https://github.com/x', commit: { message: 'x', author: { date: '2026-11-09T12:00:00Z' } } },
    { ...commit('ccccccc3', 'Elsewhere', '2026-11-09T12:00:00Z'), html_url: 'javascript:alert(1)' },
    'junk',
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.area, 'Customize');
  assert.equal(changes[0]!.body, 'Why it was broken.');
  assert.deepEqual(readCommits({ message: 'Not Found' }), []);
});

test('grouped by day, newest day first, each commit once', () => {
  const changes = readCommits([
    commit('aaaaaaa1', 'One', '2026-11-09T12:00:00'),
    commit('bbbbbbb2', 'Two', '2026-11-08T12:00:00'),
    commit('ccccccc3', 'Three, written earlier, landed later', '2026-11-09T09:00:00'),
    commit('aaaaaaa1', 'One', '2026-11-09T12:00:00'),
  ]);
  const days = byDay(changes);
  assert.deepEqual(days.map((d) => d.day), ['2026-11-09', '2026-11-08']);
  assert.deepEqual(days[0]!.changes.map((c) => c.text), ['One', 'Three, written earlier, landed later']);
});

test('pages, addresses and trouble', () => {
  assert.equal(commitsUrl('waynesutton/threadbear', 'waynesutton', 2), 'https://api.github.com/repos/waynesutton/threadbear/commits?author=waynesutton&per_page=100&page=2');
  assert.ok(hasNext('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'));
  assert.ok(!hasNext('<https://api.github.com/x?page=1>; rel="prev"'));
  assert.ok(!hasNext(null));
  assert.match(trouble(403, '0'), /limit/);
  assert.match(trouble(404, '50'), /isn’t public/);
  assert.match(trouble(500, null), /couldn’t be loaded/);
});
