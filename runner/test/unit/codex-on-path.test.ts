import assert from 'node:assert/strict';
import test from 'node:test';
import { codexOnPath } from '../../src/platform.ts';

const has = (...files: string[]) => (f: string) => files.includes(f);

test('codexOnPath finds codex.exe in the first PATH directory that has it', () => {
  const env = { PATH: 'C:\\Windows;C:\\Tools;C:\\Other' };
  assert.equal(codexOnPath({ env, exists: has('C:\\Tools\\codex.exe', 'C:\\Other\\codex.exe') }), 'C:\\Tools\\codex.exe');
});

test('codexOnPath reads Path as well as PATH, skips empty and quoted entries', () => {
  const env = { Path: ';"C:\\Program Files\\Codex";' };
  assert.equal(codexOnPath({ env, exists: has('C:\\Program Files\\Codex\\codex.exe') }), 'C:\\Program Files\\Codex\\codex.exe');
});

test('codexOnPath gives nothing when no directory has it, so Codex stays off', () => {
  assert.equal(codexOnPath({ env: { PATH: 'C:\\Windows' }, exists: () => false }), undefined);
  assert.equal(codexOnPath({ env: {}, exists: () => true }), undefined);
});
