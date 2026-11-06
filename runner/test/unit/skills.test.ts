// Skills (docs/protocol.md, "Skills"): links, pages, SKILL.md edits, and an
// import end to end against a fake GitHub serving a real tarball. Nothing
// here touches the network or a real CODEX_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Account } from '../../src/protocol.ts';
import { SkillStore, codexPolicy, findSkillInPage, parseGitHubLink, pluginSkillText, readFrontmatter } from '../../src/skills.ts';
import { nullLogger } from '../../src/log.ts';

test('GitHub links of every shape', () => {
  assert.deepEqual(parseGitHubLink('wheresryan22/anatomy'), { repo: 'wheresryan22/anatomy' });
  assert.deepEqual(parseGitHubLink('https://github.com/wheresryan22/anatomy'), { repo: 'wheresryan22/anatomy' });
  assert.deepEqual(parseGitHubLink('https://github.com/o/r.git/'), { repo: 'o/r' });
  assert.deepEqual(parseGitHubLink('https://github.com/o/r/tree/main/skills/pdf'), { repo: 'o/r', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(parseGitHubLink('https://github.com/o/r/blob/v2/skills/pdf/SKILL.md'), { repo: 'o/r', ref: 'v2', path: 'skills/pdf' });
  assert.deepEqual(parseGitHubLink('https://github.com/o/r/blob/main/SKILL.md'), { repo: 'o/r', ref: 'main' });
  assert.deepEqual(parseGitHubLink('https://raw.githubusercontent.com/o/r/main/x/SKILL.md'), { repo: 'o/r', ref: 'main', path: 'x' });
  assert.equal(parseGitHubLink('https://skills.wheresryan.sh/anatomy#install'), null);
  assert.equal(parseGitHubLink('not a link'), null);
});

test('a page names its skill by its install line, or a GitHub link', () => {
  assert.deepEqual(findSkillInPage('<code>npx skills add wheresryan22/anatomy</code>'), { repo: 'wheresryan22/anatomy' });
  assert.deepEqual(findSkillInPage('<a href="https://github.com/sponsors/x">s</a><a href="https://github.com/a/b">repo</a>'), { repo: 'a/b' });
  assert.equal(findSkillInPage('<p>no skill here</p>'), null);
});

test('frontmatter, including a folded description', () => {
  assert.deepEqual(readFrontmatter('---\nname: pele\ndescription: "Draw diagrams"\n---\nbody'), { name: 'pele', description: 'Draw diagrams' });
  assert.deepEqual(readFrontmatter('---\nname: x\ndescription: >\n  one\n  two\n---\n'), { name: 'x', description: 'one two' });
});

test('slash-only skills get disable-model-invocation, and lose it when always is back on', () => {
  const text = '---\nname: x\ndescription: d\n---\n\nBody';
  const off = pluginSkillText(text, false);
  assert.match(off, /^---\nname: x\ndescription: d\ndisable-model-invocation: true\n---\n\nBody$/);
  assert.equal(pluginSkillText(off, true), text);
  assert.equal(codexPolicy(null, false), 'policy:\n  allow_implicit_invocation: false\n');
  assert.equal(codexPolicy('interface:\n  display_name: X\n', false), 'interface:\n  display_name: X\npolicy:\n  allow_implicit_invocation: false\n');
});

/** A fake GitHub serving `files` as owner/repo at one commit. */
function fakeGitHub(files: Record<string, string>) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-src-'));
  const top = path.join(src, 'repo-abc');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, file)), { recursive: true });
    fs.writeFileSync(path.join(top, file), text);
  }
  const tarball = path.join(src, 'repo.tar.gz');
  spawnSync('/usr/bin/tar', ['-czf', tarball, '-C', src, 'repo-abc']);
  const sha = 'a'.repeat(40);
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://api.github.com/repos/o/r/commits/')) return new Response(sha);
    if (u === `https://codeload.github.com/o/r/tar.gz/${sha}`) return new Response(fs.readFileSync(tarball));
    if (u === 'https://example.com/page') return new Response('Install: npx skills add o/r');
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetcher, sha, calls };
}

function store(fetcher: typeof fetch, accounts: Account[] = [], dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skills-'))) {
  const published: unknown[] = [];
  let refreshed = 0;
  const s = new SkillStore({ dataDir, accounts: () => accounts, publish: (n) => published.push(n), log: nullLogger, fetch: fetcher, version: '9.9.9', onChange: () => refreshed++ });
  return { s, dataDir, published, refreshed: () => refreshed };
}

test('importing a repo of skills pins each one and builds the plugin', async () => {
  const gh = fakeGitHub({
    'README.md': 'hi',
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\nDo A',
    'skills/alpha/run.mjs': 'console.log(1)',
    'skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\nDo B',
  });
  const { s, dataDir, published } = store(gh.fetcher);
  const res = await s.add({ url: 'https://github.com/o/r' });
  assert.deepEqual(res.added, ['alpha', 'beta']);
  const alpha = res.skills.find((k) => k.name === 'alpha')!;
  assert.equal(alpha.commit, gh.sha);
  assert.equal(alpha.always, true);
  assert.ok(alpha.dir.endsWith(`alpha@${gh.sha.slice(0, 7)}`));
  const view = path.join(dataDir, 'skills', 'plugin', 'skills', 'alpha');
  assert.equal(fs.readFileSync(path.join(view, 'SKILL.md'), 'utf8'), '---\nname: alpha\ndescription: A\n---\nDo A');
  assert.ok(fs.lstatSync(path.join(view, 'run.mjs')).isSymbolicLink());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'skills', 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).name, 'threadbear');
  assert.deepEqual(s.plugins(), [{ type: 'local', path: path.join(dataDir, 'skills', 'plugin') }]);
  assert.equal(published.length, 1);
  await assert.rejects(s.add({ url: 'o/r' }), /already a skill called alpha/);
});

test('a page with an install line imports its repo', async () => {
  const gh = fakeGitHub({ 'SKILL.md': '---\nname: solo\ndescription: S\n---\n' });
  const { s } = store(gh.fetcher);
  const res = await s.add({ url: 'https://example.com/page' });
  assert.deepEqual(res.added, ['solo']);
  assert.equal(res.skills[0].source.kind === 'github' && res.skills[0].source.url, 'https://github.com/o/r');
});

test('turning always off makes it slash-only for Claude and Codex', async () => {
  const gh = fakeGitHub({ 'SKILL.md': '---\nname: solo\ndescription: S\n---\nBody' });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-'));
  const { s, dataDir } = store(gh.fetcher, [{ id: 'codex-main', provider: 'codex', title: 'c', configDir: codexHome } as Account]);
  await s.add({ url: 'o/r' });
  const link = path.join(codexHome, 'skills', 'solo');
  assert.equal(fs.readlinkSync(link), path.join(dataDir, 'skills', 'plugin', 'skills', 'solo'));
  await s.update({ name: 'solo', always: false });
  const view = path.join(dataDir, 'skills', 'plugin', 'skills', 'solo');
  assert.match(fs.readFileSync(path.join(view, 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  assert.match(fs.readFileSync(path.join(view, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  // The link still goes through to the same folder, now slash-only.
  assert.match(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);
  await s.remove({ name: 'solo' });
  assert.equal(fs.existsSync(link), false);
  assert.deepEqual(s.plugins(), []);
  assert.equal(fs.readdirSync(path.join(dataDir, 'skills')).filter((e) => e.includes('@')).length, 0);
});

test("a Codex skill that isn't ours is left alone", async () => {
  const gh = fakeGitHub({ 'SKILL.md': '---\nname: solo\ndescription: S\n---\n' });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-'));
  fs.mkdirSync(path.join(codexHome, 'skills', 'solo'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'skills', 'solo', 'SKILL.md'), 'mine');
  const { s } = store(gh.fetcher, [{ id: 'codex-main', provider: 'codex', title: 'c', configDir: codexHome } as Account]);
  await s.add({ url: 'o/r' });
  assert.equal(fs.readFileSync(path.join(codexHome, 'skills', 'solo', 'SKILL.md'), 'utf8'), 'mine');
  await s.remove({ name: 'solo' });
  assert.equal(fs.readFileSync(path.join(codexHome, 'skills', 'solo', 'SKILL.md'), 'utf8'), 'mine');
});

test('a link with no skill, or a private repo, says why', async () => {
  const gh = fakeGitHub({ 'README.md': 'no skills' });
  const { s } = store(gh.fetcher);
  await assert.rejects(s.add({ url: 'o/r' }), /no SKILL\.md/);
  await assert.rejects(s.add({ url: 'x/private' }), /wasn't found/);
  await assert.rejects(s.add({ url: 'https://example.com/nothing' }), /wasn't found/);
});

test('the built-in Pele is suggested until added', () => {
  const { s } = store((async () => new Response('', { status: 404 })) as typeof fetch);
  const suggested = s.list().suggested.map((x) => x.id);
  assert.ok(suggested.includes('pele'));
  assert.ok(suggested.includes('anatomy'));
});

test('turning the store off takes every skill away, keeps them, and brings them back', async () => {
  const gh = fakeGitHub({ 'SKILL.md': '---\nname: solo\ndescription: S\n---\n' });
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-'));
  const accounts = [{ id: 'codex-main', provider: 'codex', title: 'c', configDir: codexHome } as Account];
  const { s, dataDir, refreshed } = store(gh.fetcher, accounts);
  await s.add({ url: 'o/r' });
  assert.equal(refreshed(), 1);
  const off = await s.setEnabled(false);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.skills.map((k) => k.name), ['solo']);
  assert.deepEqual(s.plugins(), []);
  assert.equal(fs.existsSync(path.join(codexHome, 'skills', 'solo')), false);
  assert.equal(refreshed(), 2);
  // Kept across a restart.
  const again = store(gh.fetcher, accounts, dataDir).s;
  assert.equal(again.list().enabled, false);
  await again.setEnabled(true);
  assert.equal(again.plugins().length, 1);
  assert.ok(fs.lstatSync(path.join(codexHome, 'skills', 'solo')).isSymbolicLink());
});
