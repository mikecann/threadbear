#!/usr/bin/env node
// Whether the desktop/ changes between two commits can be patched into the
// running app (desktop/scripts/hotpatch.sh), or need it built and started
// again:
//
//   node hotpatch-classify.mjs <checkout> <from> <to>
//
// Prints "patch" or "restart: <why>", and "none" when nothing under desktop/
// that the app is built from changed.
//
// A patch swaps functions in the running app (subsecond, through dx) and
// leaves its memory alone. So a change to the shape of anything already in
// memory can't go in that way: a struct's or enum's fields, a trait (its
// vtable), a static. Patched code would read old values with the new layout.
// Neither can anything dx doesn't patch: the Cargo files, build scripts, the
// Objective-C beside the Rust, assets, and the vendored crates (they aren't
// workspace members). A new type, or a changed function body, can.
import { execFileSync } from 'node:child_process';

const [checkout, from, to] = process.argv.slice(2);
if (!checkout || !from || !to) {
  console.error('usage: hotpatch-classify.mjs <checkout> <from> <to>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const show = (rev, file) => {
  try {
    return execFileSync('git', ['-C', checkout, 'show', `${rev}:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const changed = git('diff', '--name-only', from, to, '--', 'desktop/').split('\n').filter(Boolean);
// What the app isn't built from: docs, tests, the specs' and scripts' files.
const ignored = (f) => /\.md$/.test(f) || /^desktop\/(scripts|test)\//.test(f) || /\/tests\//.test(f) || /^desktop\/[^/]+\/benches\//.test(f);
const relevant = changed.filter((f) => !ignored(f));
if (relevant.length === 0) {
  console.log('none');
  process.exit(0);
}

const notPatchable = relevant.filter((f) => !f.endsWith('.rs') || f.startsWith('desktop/vendor/') || /\/build\.rs$/.test(f));
if (notPatchable.length) {
  console.log(`restart: ${notPatchable.slice(0, 3).join(', ')}${notPatchable.length > 3 ? ` and ${notPatchable.length - 3} more` : ''} changed`);
  process.exit(0);
}

// Each struct, enum, union, trait and static in a file, by name, as its text
// with comments and spacing taken out.
function shapes(source) {
  const out = new Map();
  if (source == null) return out;
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const head = /(^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|union|trait|static|thread_local!)\s*(?:mut\s+)?(\w*)/g;
  let m;
  while ((m = head.exec(text))) {
    const kind = m[2];
    const start = m.index + m[1].length;
    // To the block's closing brace, or the first `;` before any brace.
    let i = head.lastIndex;
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{' || c === '(') depth++;
      else if (c === '}' || c === ')') {
        depth--;
        if (depth === 0 && c === '}' && kind !== 'static') break;
      } else if (c === ';' && depth === 0) break;
    }
    const body = text.slice(start, i + 1).replace(/\s+/g, ' ').trim();
    // A thread_local! block is known by the statics in it, as its place in
    // the file moves with every line added above it.
    const inner = kind === 'thread_local!' ? [...body.matchAll(/static\s+(\w+)/g)].map((s) => s[1]).join(',') : '';
    const name = `${kind} ${m[3] || inner || body}`;
    out.set(out.has(name) ? `${name}#${out.size}` : name, body);
    head.lastIndex = i + 1;
  }
  return out;
}

for (const file of relevant) {
  const before = shapes(show(from, file));
  const after = shapes(show(to, file));
  for (const [name, body] of before) {
    if (!after.has(name)) {
      console.log(`restart: ${name} went from ${file}`);
      process.exit(0);
    }
    if (after.get(name) !== body) {
      console.log(`restart: ${name} changed shape in ${file}`);
      process.exit(0);
    }
  }
}
console.log('patch');
