// The secrets folder's ACL on Windows (src/win-acl.ts). The commands are
// checked here on any system; the last test runs them for real on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aclArgs, makePrivate, sidFrom } from '../../src/win-acl.ts';

test("whoami's line gives the SID", () => {
  assert.equal(sidFrom('"dell-xps\\\\mikec","S-1-5-21-1111-2222-3333-1001"\r\n'), 'S-1-5-21-1111-2222-3333-1001');
  assert.equal(sidFrom('USER INFORMATION\n'), undefined);
});

test('the folder inherits nothing, and only this user and SYSTEM get in', () => {
  assert.deepEqual(aclArgs('C:\\x\\secrets', 'S-1-5-21-1-2-3-1001'), ['C:\\x\\secrets', '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '/q']);
});

test('off Windows it does nothing', async () => {
  const calls: string[] = [];
  assert.equal(await makePrivate('/x/secrets', { platform: 'darwin', run: async (f) => (calls.push(f), '') }), undefined);
  assert.deepEqual(calls, []);
});

test('on Windows: whoami, then icacls, both from System32', async () => {
  const calls: [string, string[]][] = [];
  const why = await makePrivate('C:\\x\\secrets', {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    run: async (f, a) => (calls.push([f, a]), f.endsWith('whoami.exe') ? '"pc\\me","S-1-5-21-9-9-9-1001"\r\n' : 'Successfully processed 1 files'),
  });
  assert.equal(why, undefined);
  assert.deepEqual(calls.map(([f]) => f), ['C:\\Windows\\System32\\whoami.exe', 'C:\\Windows\\System32\\icacls.exe']);
  assert.deepEqual(calls[1]![1], aclArgs('C:\\x\\secrets', 'S-1-5-21-9-9-9-1001'));
});

test('a failure is said, not thrown', async () => {
  const why = await makePrivate('C:\\x\\secrets', { platform: 'win32', env: {}, run: async () => { throw new Error('icacls.exe failed: Access is denied.'); } });
  assert.match(why ?? '', /Access is denied/);
  assert.match((await makePrivate('C:\\x', { platform: 'win32', env: {}, run: async () => 'nothing useful' })) ?? '', /SID/);
});

test('for real: a new file in the folder is readable by this user, and the folder lists only this user and SYSTEM', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acl-'));
  try {
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets);
    assert.equal(await makePrivate(secrets), undefined);
    fs.writeFileSync(path.join(secrets, 'key'), 'k');
    assert.equal(fs.readFileSync(path.join(secrets, 'key'), 'utf8'), 'k');
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    for (const target of [secrets, path.join(secrets, 'key')]) {
      const lines = execFileSync(icacls, [target], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map((l) => l.replace(target, '').trim()).filter((l) => l.includes(':('));
      assert.equal(lines.length, 2, lines.join(' | '));
      assert.ok(lines.some((l) => /^NT AUTHORITY\\SYSTEM:/i.test(l)), lines.join(' | '));
      assert.ok(lines.every((l) => !/Users|Everyone|Authenticated|Administrators/i.test(l)), lines.join(' | '));
    }
    // Running it again changes nothing.
    assert.equal(await makePrivate(secrets), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
