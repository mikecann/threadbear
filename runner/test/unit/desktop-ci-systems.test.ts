// Which systems the Desktop app workflow (.github/workflows/desktop.yml) runs
// on: its systems job turns the DESKTOP_CI_SYSTEMS repository variable into
// the build job's rows. All three when it's unset (Mike's repo, or started by
// hand); a fork that sets it runs only those. This runs that job's script as
// GitHub would, so the rows can't drift from what the comments say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop.yml'), 'utf8');

// A workflow's jobs, each as its own text (two-space-indented keys under `jobs:`).
function jobsOf(text: string): Map<string, string> {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return new Map(heads.map((m, i) => [m[1], body.slice(m.index, heads[i + 1]?.index ?? body.length)]));
}

// The `run: |` block of the systems job's one step, unindented.
function pickScript(): string {
  const job = jobsOf(workflow).get('systems');
  assert.ok(job, 'desktop.yml has a systems job');
  const lines = job.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at > 0, 'its step has a run: | block');
  const body: string[] = [];
  const indent = lines[at + 1].length - lines[at + 1].trimStart().length;
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && l.length - l.trimStart().length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

type Row = { name: string; os: string; shard?: string; specsOnly?: boolean };

function pick(systems: string | undefined): { ok: boolean; rows: Row[]; any?: string; out: string } {
  const dir = tmpDir();
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GITHUB_OUTPUT: output };
  if (systems !== undefined) env.SYSTEMS = systems;
  const r = spawnSync('bash', ['-c', pickScript()], { env, encoding: 'utf8' });
  const got = Object.fromEntries(
    fs
      .readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const rows = got.matrix ? (JSON.parse(got.matrix) as { include: Row[] }).include : [];
  return { ok: r.status === 0, rows, any: got.any, out: r.stdout + r.stderr };
}

const names = (rows: Row[]) => rows.map((r) => r.name);
const ALL = ['Linux', 'Linux specs 2 of 2', 'Mac', 'Windows'];

test('unset, empty or all runs every system, with the rows as they were', () => {
  for (const v of [undefined, '', 'all', 'ALL']) {
    const p = pick(v);
    assert.ok(p.ok, p.out);
    assert.deepEqual(names(p.rows), ALL, `for ${JSON.stringify(v)}`);
    assert.equal(p.any, 'true');
  }
  assert.deepEqual(pick(undefined).rows, [
    { name: 'Linux', os: 'ubuntu-24.04', shard: '1/2' },
    { name: 'Linux specs 2 of 2', os: 'ubuntu-24.04', shard: '2/2', specsOnly: true },
    { name: 'Mac', os: 'macos-26' },
    { name: 'Windows', os: 'windows-latest' },
  ]);
});

test("a fork's list runs only those systems, Linux's two shards together", () => {
  assert.deepEqual(names(pick('mac').rows), ['Mac']);
  assert.deepEqual(names(pick('linux').rows), ['Linux', 'Linux specs 2 of 2']);
  assert.deepEqual(names(pick(' Windows , mac').rows), ['Mac', 'Windows']);
  assert.deepEqual(names(pick('mac,mac,all').rows), ALL);
});

test('a list naming nothing skips the build, and a word it doesn\'t know fails saying why', () => {
  for (const v of ['off', 'none', ',']) {
    const p = pick(v);
    assert.ok(p.ok, p.out);
    assert.deepEqual(p.rows, []);
    assert.equal(p.any, 'false');
  }
  const bad = pick('mac,macos');
  assert.equal(bad.ok, false);
  assert.match(bad.out, /DESKTOP_CI_SYSTEMS has "macos": use mac, linux, windows or all/);
});

test('the build job takes its rows from the systems job, and skips when there are none', () => {
  const build = jobsOf(workflow).get('build');
  assert.ok(build);
  assert.match(build, /needs: systems/);
  assert.match(build, /if: needs\.systems\.outputs\.any == 'true'/);
  assert.match(build, /matrix: \$\{\{ fromJSON\(needs\.systems\.outputs\.matrix\) \}\}/);
  // Unset in a fork, nothing starts on a push: Mike's repo, by hand, or opted in.
  assert.match(jobsOf(workflow).get('systems')!, /if: github\.repository == 'mikecann\/threadbear' \|\| github\.event_name == 'workflow_dispatch' \|\| vars\.DESKTOP_CI_SYSTEMS != ''/);
});
