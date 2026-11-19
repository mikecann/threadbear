// desktop/scripts/hotpatch-classify.mjs: which of Mike's changes can be
// patched into the running app, and which need a full build.
//
//   node --test desktop/test/hotpatch-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'hotpatch-classify.mjs');

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpatch-classify-'));
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'c', '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  const classify = (from, to) => execFileSync('node', [script, dir, from, to], { encoding: 'utf8' }).trim();
  return { write, commit, classify };
}

const base = `// A view.
pub struct Card {
    title: String,
}

impl Card {
    fn label(&self) -> String {
        self.title.clone()
    }
}

thread_local! {
    static SEEN: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}
`;

test('a changed function body is a patch', () => {
  const r = repo();
  r.write('desktop/gpui/src/card.rs', base);
  const a = r.commit();
  r.write('desktop/gpui/src/card.rs', base.replace('self.title.clone()', 'format!("{}!", self.title)'));
  assert.equal(r.classify(a, r.commit()), 'patch');
});

test('a new field is a full build', () => {
  const r = repo();
  r.write('desktop/gpui/src/card.rs', base);
  const a = r.commit();
  r.write('desktop/gpui/src/card.rs', base.replace('title: String,', 'title: String,\n    pinned: bool,'));
  assert.match(r.classify(a, r.commit()), /^restart: struct Card changed shape/);
});

test('a new type is a patch, and lines added above a thread_local! leave it alone', () => {
  const r = repo();
  r.write('desktop/gpui/src/card.rs', base);
  const a = r.commit();
  r.write('desktop/gpui/src/card.rs', `struct Extra;\n// more\n${base}`);
  assert.equal(r.classify(a, r.commit()), 'patch');
});

test('Cargo files, the vendored crates and the Objective-C are full builds', () => {
  for (const file of ['desktop/Cargo.toml', 'desktop/vendor/gpui-pre/src/view.rs', 'desktop/gpui/native/media_views.m', 'desktop/gpui/build.rs']) {
    const r = repo();
    r.write(file, 'a');
    const a = r.commit();
    r.write(file, 'b');
    assert.match(r.classify(a, r.commit()), /^restart: /, file);
  }
});

test('docs, tests and scripts are nothing to do', () => {
  const r = repo();
  r.write('desktop/README.md', 'a');
  r.write('desktop/scripts/x.sh', 'a');
  r.write('runner/src/x.ts', 'a');
  const a = r.commit();
  r.write('desktop/README.md', 'b');
  r.write('desktop/scripts/x.sh', 'b');
  r.write('runner/src/x.ts', 'b');
  assert.equal(r.classify(a, r.commit()), 'none');
});
