// git started by name with no hardening, in a folder a thread works in,
// runs what that repo's own .git names, and on Windows can start a git.exe
// planted in the folder. Runner code goes through safe-git.ts; these are
// the few that don't, each with why (Gemini's break-it review of 187/188,
// 28 Nov 2026, found five more).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../../src');
const ALLOWED: Record<string, string> = {
  'checkup.ts': 'listing-only config and environment from safe-git.ts (LISTING_GIT_CONFIG, LISTING_GIT_ENV), on this copy of Threadbear',
  'sentry.ts': "reads this copy of Threadbear's origin for the release tag, nothing a thread's repo can reach",
  'shell-allowlist.ts': "a live command's git: its own checks refuse any repo config that could run something",
  'tb-dev.ts': 'the developer tool, run by hand in a checkout of Threadbear',
  'upstream.ts': 'the release check, with its own configless, repo-proof git',
};

test('runner code starts git only through safe-git.ts, but for the listed exceptions', () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.name.endsWith('.ts') && e.name !== 'safe-git.ts' && /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*'git'/.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(SRC, file));
    }
  };
  walk(SRC);
  assert.deepEqual(found.filter((f) => !(f in ALLOWED)).sort(), [], 'route these through untrustedGit/untrustedGitRunSync, or add them to ALLOWED with why');
});

test("tb keeps Windows from running a program from the folder it's in, as the runner does", () => {
  const cli = fs.readFileSync(path.join(SRC, 'cli.ts'), 'utf8');
  assert.match(cli, /process\.env\.NoDefaultCurrentDirectoryInExePath = '1'/);
});
