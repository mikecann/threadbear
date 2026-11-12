import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printDoc, PRINT_POLICY } from './print-doc.ts';

test('the policy goes in front of the print, after its doctype', () => {
  const out = printDoc('<!doctype html>\n<html><head><title>x</title></head><body>hi</body></html>');
  assert.ok(out.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"'));
  assert.ok(out.indexOf(PRINT_POLICY) < out.indexOf('<html>'));
  assert.ok(out.includes('<base target="_blank">'));
  assert.ok(printDoc('<p>bare</p>').startsWith('<meta http-equiv="Content-Security-Policy"'));
});

test('the policy allows nothing from the network and no scripts', () => {
  assert.match(PRINT_POLICY, /default-src 'none'/);
  assert.doesNotMatch(PRINT_POLICY, /script-src|connect-src|https?:/);
});
