import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { git as worktreeGit } from '../../src/worktrees.ts';
import { git as formatGit } from '../../src/format-replay.ts';
import { IS_WINDOWS } from '../../src/platform.ts';

function fixture() {
  const root = tmpDir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const marker = path.join(root, 'ran');
  const hook = path.join(root, 'hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\nprintf ran >> '${marker}'\n`, { mode: 0o755 });
  return { root, repo, g, marker, hook };
}

for (const [label, run] of [['worktree', worktreeGit], ['format', formatGit]] as const) {
  test(`${label} git suppresses checkout/rebase hooks, filters, signing and merge drivers`, { skip: IS_WINDOWS }, async () => {
    const { root, repo, g, marker, hook } = fixture();
    const hooks = path.join(root, 'hooks'); fs.mkdirSync(hooks);
    for (const name of ['post-checkout', 'pre-rebase', 'pre-commit', 'post-merge']) fs.copyFileSync(hook, path.join(hooks, name));
    g('config', 'core.hooksPath', hooks);
    g('config', 'filter.evil.clean', `${hook}; cat`); g('config', 'filter.evil.smudge', `${hook}; cat`);
    g('config', 'merge.verifySignatures', 'true'); g('config', 'log.showSignature', 'true'); g('config', 'push.gpgSign', 'true'); g('config', 'push.recurseSubmodules', 'on-demand');
    g('config', 'rebase.instructionFormat', '%s%nexec ' + hook); g('config', 'sequence.editor', hook);
    g('config', 'merge.evil.driver', hook); g('config', 'gpg.program', hook); g('config', 'commit.gpgSign', 'true');
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil merge=evil\n');
    assert.ok((await run(repo, ['add', '.'])).ok);
    assert.ok((await run(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'attrs'])).ok);
    assert.ok((await run(repo, ['checkout', '-qb', 'topic'])).ok);
    fs.writeFileSync(path.join(repo, 'a'), 'topic\n');
    assert.ok((await run(repo, ['add', '.'])).ok);
    assert.ok((await run(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'topic'])).ok);
    assert.ok((await run(repo, ['checkout', '-q', 'main'])).ok);
    fs.writeFileSync(path.join(repo, 'a'), 'main\n');
    assert.ok((await run(repo, ['add', '.'])).ok);
    assert.ok((await run(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'main'])).ok);
    assert.ok((await run(repo, ['checkout', '-q', 'topic'])).ok);
    assert.ok((await run(repo, ['log', '-1', '-p'])).ok);
    assert.ok((await run(repo, ['show', 'HEAD'])).ok);
    const beforeRebase = g('rev-parse', 'HEAD');
    const rebased = await run(repo, ['rebase', 'main']);
    assert.equal(rebased.ok, false, 'the text conflict stays a conflict');
    const aborted = await run(repo, ['rebase', '--abort']);
    assert.ok(aborted.ok, aborted.stderr); assert.equal(g('rev-parse', 'HEAD'), beforeRebase);
    assert.equal(fs.existsSync(marker), false, 'none of the configured programs ran');
    const sibling = path.join(root, 'sibling');
    assert.ok((await run(repo, ['worktree', 'add', '-b', 'other', sibling, 'main'])).ok);
    assert.equal(fs.existsSync(marker), false);
  });
}

test('worktree creation refuses repository conditionals that only activate in the new worktree', { skip: IS_WINDOWS }, async () => {
  const { root, repo, g, hook, marker } = fixture();
  fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=late\n');
  g('add', '.'); g('commit', '-qm', 'attrs');
  const config = path.join(root, 'new-worktree-config');
  fs.writeFileSync(config, `[filter "late"]\n  smudge = ${hook}\n  required = true\n`);
  g('config', `includeIf.gitdir:${repo}/.git/worktrees/.path`, config);
  const dest = path.join(root, 'new-worktree');
  const r = await worktreeGit(repo, ['worktree', 'add', '-b', 'new', dest, 'main']);
  assert.equal(r.ok, false); assert.match(r.stderr, /conditional git includes/);
  assert.equal(fs.existsSync(dest), false); assert.equal(fs.existsSync(marker), false);
});

test('the documented standalone format replay loads from its three release modules', () => {
  const dir = tmpDir();
  for (const file of ['format-replay.ts', 'safe-git.ts', 'platform.ts']) fs.copyFileSync(path.resolve(import.meta.dirname, '../../src', file), path.join(dir, file));
  const text = execFileSync(process.execPath, [path.join(dir, 'format-replay.ts'), '--help'], { encoding: 'utf8' });
  assert.match(text, /replay-over-format/);
});

test('signature-looking objects never invoke repository verification programs during log/show/merge', { skip: IS_WINDOWS }, async () => {
  const { repo, g, hook, marker } = fixture();
  const tree = g('rev-parse', 'HEAD^{tree}'), parent = g('rev-parse', 'HEAD');
  const raw = `tree ${tree}\nparent ${parent}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nfake signed commit\n`;
  const id = execFileSync('git', ['-C', repo, 'hash-object', '-w', '-t', 'commit', '--stdin'], { input: raw, encoding: 'utf8' }).trim();
  g('config', 'format.pretty', '%G?'); g('config', 'gpg.program', hook); g('config', 'log.showSignature', 'true'); g('config', 'merge.verifySignatures', 'true');
  g('config', 'branch.main.mergeOptions', '--verify-signatures --gpg-sign');
  for (const run of [worktreeGit, formatGit]) {
    assert.ok((await run(repo, ['log', '-1', id])).ok);
    assert.ok((await run(repo, ['show', id])).ok);
    const merged = await run(repo, ['merge', '--ff-only', id]);
    assert.ok(merged.ok, merged.stderr);
    assert.equal(fs.existsSync(marker), false);
    g('reset', '--hard', parent);
  }
});

test('format replay does not reintroduce inherited executable Git environment overrides', { skip: IS_WINDOWS }, async () => {
  const { repo, g, hook, marker } = fixture();
  fs.writeFileSync(path.join(repo, 'b'), 'later\n'); g('add', '.'); g('commit', '-qm', 'later');
  const oldSequence = process.env.GIT_SEQUENCE_EDITOR, oldEditor = process.env.GIT_EDITOR;
  try {
    process.env.GIT_SEQUENCE_EDITOR = hook; process.env.GIT_EDITOR = hook;
    const r = await formatGit(repo, ['rebase', '-i', 'HEAD~1']);
    assert.ok(r.ok, r.stderr); assert.equal(fs.existsSync(marker), false);
  } finally {
    if (oldSequence === undefined) delete process.env.GIT_SEQUENCE_EDITOR; else process.env.GIT_SEQUENCE_EDITOR = oldSequence;
    if (oldEditor === undefined) delete process.env.GIT_EDITOR; else process.env.GIT_EDITOR = oldEditor;
  }
});
