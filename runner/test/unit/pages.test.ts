import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_HTML_BYTES, MAX_VERSIONS, PageError, Pages } from '../../src/pages.ts';
import type { ThreadProject } from '../../src/protocol.ts';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pages-'));
const proj = (id: string, pinned: boolean): ThreadProject => ({ id, title: id, by: 'agent', at: '2026-11-10T00:00:00.000Z', ...(pinned ? { pinned } : {}) });
const page = (body: string) => `<!doctype html><title>t</title><body>${body}</body>`;

test('diagram Prints keep Mermaid through edits, restore, rename and export without scripts', () => {
  const store = new Pages(home());
  const source = 'flowchart LR\n A[Start] --> B[Done]';
  const made = store.create({ title: 'Checkout <flow>', summary: '', ownerThread: 't', mermaid: source });
  assert.equal(made.kind, 'diagram');
  assert.equal(store.mermaid(made.id), source);
  const html = fs.readFileSync(store.file(made.id), 'utf8');
  assert.match(html, /<svg/);
  assert.match(html, /Checkout &lt;flow&gt;/);
  assert.match(html, /Mermaid source/);
  assert.doesNotMatch(html, /<script\b|\son\w+\s*=/i);
  assert.ok(store.publishable(made.id).html.includes('<svg'));
  const changed = store.update(made.id, { mermaid: 'sequenceDiagram\n Alice->>Bob: Hello', by: 'user' });
  assert.equal(changed.version, 2);
  assert.equal(changed.editedBy, 'user');
  assert.equal(store.mermaid(made.id, 1), source);
  store.update(made.id, { markdown: '# A different kind' });
  assert.equal(store.restoreVersion(made.id, 1).kind, 'diagram');
  assert.equal(store.mermaid(made.id), source);
  assert.equal(store.update(made.id, { title: 'New title' }).version, 5);
  assert.match(fs.readFileSync(store.file(made.id), 'utf8'), /New title/);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-diagram-export-'));
  store.exportTo(made.id, output);
  assert.equal(fs.readFileSync(path.join(output, 'source.mmd'), 'utf8'), source);
  assert.match(fs.readFileSync(path.join(output, 'diagram.svg'), 'utf8'), /<svg/);
});

test('invalid diagram input leaves the old version intact; editor RPC and tools return Mermaid', async () => {
  const store = new Pages(home());
  const made = store.create({ title: 'Flow', summary: '', ownerThread: 't', mermaid: 'flowchart LR\n A --> B' });
  assert.throws(() => store.update(made.id, { mermaid: 'not a diagram' }), /diagram/i);
  assert.throws(() => store.update(made.id, { mermaid: 'x'.repeat(20_001) }), /20,?000/);
  assert.throws(() => store.update(made.id, { html: page('mixed'), mermaid: 'flowchart LR\n A --> B' }), /one of them/);
  assert.equal(store.get(made.id)?.version, 1);
  const { pageMethods } = await import('../../src/pages.ts');
  const methods = pageMethods(() => store);
  methods['pages.saveDiagram']!({ pageId: made.id, mermaid: 'flowchart LR\n B --> C' });
  assert.equal((methods['pages.get']!({ pageId: made.id }) as { mermaid: string }).mermaid, 'flowchart LR\n B --> C');
  assert.equal(store.get(made.id)?.editedBy, 'user');
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const control = { list: async () => [{ id: 't', cwd: os.tmpdir(), projects: [] }], get: async () => ({ permissionMode: 'full' }) } as never;
  const tools = buildThreadbearTools(control, 't', Date.now, undefined, undefined, undefined, { pages: () => store }) as unknown as Tool[];
  assert.match((await call(tools, 'read_print', { id: made.id })).text, /mermaid:\nflowchart LR\n B --> C/);
  const result = await call(tools, 'create_print', { title: 'Tool flow', summary: '', mermaid: 'flowchart LR\n A --> B' });
  assert.equal(result.err, false, result.text);
  assert.equal(store.get('pg_tool_flow')?.kind, 'diagram');
});

test('replacing diagram source with HTML and restoring an HTML version clears its editable kind', () => {
  const store = new Pages(home());
  const made = store.create({ title: 'Flow', summary: '', ownerThread: 't', html: page('original') });
  store.update(made.id, { mermaid: 'flowchart LR\n A --> B' });
  assert.equal(store.restoreVersion(made.id, 1).kind, 'page');
  assert.equal(store.mermaid(made.id), undefined);
  store.restoreVersion(made.id, 2);
  assert.equal(store.get(made.id)?.kind, 'diagram');
  assert.equal(store.update(made.id, { html: page('replacement') }).kind, 'page');
  assert.equal(store.mermaid(made.id), undefined);
});

test('diagram edits preserve a live Print permission so its old scripted version can be restored', () => {
  const store = new Pages(home());
  const live = store.create({ title: 'Live flow', summary: '', ownerThread: 't', html: page('<script>1</script>'), live: true });
  const diagram = store.update(live.id, { mermaid: 'flowchart LR\n A --> B' });
  assert.equal(diagram.live, true, 'an edit must not revoke the existing Print permission');
  assert.doesNotMatch(fs.readFileSync(store.file(live.id), 'utf8'), /<script\b/i, 'Mermaid still renders static content');
  assert.equal(store.restoreVersion(live.id, 1).live, true);
  assert.match(fs.readFileSync(store.file(live.id), 'utf8'), /<script>1<\/script>/);
  assert.equal(store.restoreVersion(live.id, 2).kind, 'diagram');
  const fresh = store.create({ title: 'New flow', summary: '', ownerThread: 't', mermaid: 'flowchart LR\n A --> B' });
  assert.equal(fresh.live, false);
});

test('create writes v1, update bumps the version in place, and both survive a reload', () => {
  const h = home();
  let t = Date.parse('2026-11-10T00:00:00Z');
  const pages = new Pages(h, () => t);
  const p = pages.create({ title: 'Bundle size', summary: '20.22 MB', ownerThread: 'th1', html: page('one'), source: 'bundle-analyzer summary' });
  assert.equal(p.id, 'pg_bundle_size');
  assert.equal(p.version, 1);
  assert.match(fs.readFileSync(pages.file(p.id), 'utf8'), /one/);
  t += 1000;
  const u = pages.update(p.id, { html: page('two'), summary: '19.8 MB' });
  assert.equal(u.version, 2);
  assert.equal(u.summary, '19.8 MB');
  assert.match(fs.readFileSync(pages.file(p.id), 'utf8'), /two/);
  assert.match(fs.readFileSync(pages.file(p.id, 1), 'utf8'), /one/);
  const again = new Pages(h);
  assert.equal(again.get(p.id)?.version, 2);
  assert.equal(again.list({ source: 'bundle-analyzer summary' }).length, 1);
});

test('a title-only update keeps the version', () => {
  const pages = new Pages(home());
  const p = pages.create({ title: 'Progress', summary: '', ownerThread: 'th1', html: page('x') });
  assert.equal(pages.update(p.id, { title: 'Render progress' }).version, 1);
});

test('only the newest versions are kept', () => {
  const pages = new Pages(home());
  const p = pages.create({ title: 'P', summary: '', ownerThread: 'th1', html: page('0') });
  for (let i = 1; i <= MAX_VERSIONS + 2; i++) pages.update(p.id, { html: page(String(i)) });
  const newest = MAX_VERSIONS + 3;
  assert.ok(fs.existsSync(pages.file(p.id, newest)));
  assert.ok(fs.existsSync(pages.file(p.id, newest - MAX_VERSIONS + 1)));
  assert.ok(!fs.existsSync(pages.file(p.id, newest - MAX_VERSIONS)));
  assert.ok(!fs.existsSync(pages.file(p.id, 1)));
});

test('static pages refuse scripts; live pages keep them', () => {
  const pages = new Pages(home());
  assert.throws(() => pages.create({ title: 'S', summary: '', ownerThread: 't', html: page('<SCRIPT>1</script>') }), PageError);
  assert.equal(pages.list().length, 0);
  const live = pages.create({ title: 'L', summary: '', ownerThread: 't', html: page('<script>1</script>'), live: true });
  assert.equal(live.live, true);
});

test('size caps and the html-or-dir rule', () => {
  const pages = new Pages(home());
  assert.throws(() => pages.create({ title: 'Big', summary: '', ownerThread: 't', html: 'x'.repeat(MAX_HTML_BYTES + 1) }), /most is/);
  assert.throws(() => pages.create({ title: 'None', summary: '', ownerThread: 't' }), /one of them/);
  assert.throws(() => pages.create({ title: '  ', summary: '', ownerThread: 't', html: page('x') }), /title/);
});

test('a folder page copies its assets and refuses links, scripts and data files', () => {
  const pages = new Pages(home());
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-page-src-'));
  fs.writeFileSync(path.join(src, 'index.html'), page('<img src="fig.svg">'));
  fs.writeFileSync(path.join(src, 'fig.svg'), '<svg/>');
  fs.mkdirSync(path.join(src, 'clip'));
  fs.writeFileSync(path.join(src, 'clip', 'clip.mp4'), Buffer.alloc(10));
  const p = pages.create({ title: 'Folder', summary: '', ownerThread: 't', dir: src });
  const v = path.dirname(pages.file(p.id));
  assert.ok(fs.existsSync(path.join(v, 'fig.svg')));
  assert.ok(fs.existsSync(path.join(v, 'clip', 'clip.mp4')));

  fs.writeFileSync(path.join(src, 'data.json'), '{}');
  assert.throws(() => pages.update(p.id, { dir: src }), /data\.json/);
  fs.rmSync(path.join(src, 'data.json'));
  fs.writeFileSync(path.join(src, 'app.js'), '');
  assert.throws(() => pages.update(p.id, { dir: src }), /app\.js/);
  fs.rmSync(path.join(src, 'app.js'));
  fs.symlinkSync('/etc/hosts', path.join(src, 'hosts.html'));
  assert.throws(() => pages.update(p.id, { dir: src }), /link/);
  assert.equal(pages.get(p.id)?.version, 1);
});

test('projects: one pinned project is inherited, none or several are not, [] means none', () => {
  const pages = new Pages(home());
  const one = pages.create({ title: 'A', summary: '', ownerThread: 't', html: page('a'), ownerProjects: [proj('p_tb', true), proj('p_misc', false)] });
  assert.deepEqual(one.projects.map((p) => p.id), ['p_tb']);
  const two = pages.create({ title: 'B', summary: '', ownerThread: 't', html: page('b'), ownerProjects: [proj('p_tb', true), proj('p_poddle', true)] });
  assert.deepEqual(two.projects, []);
  const guessed = pages.create({ title: 'C', summary: '', ownerThread: 't', html: page('c'), ownerProjects: [proj('p_tb', false)] });
  assert.deepEqual(guessed.projects, []);
  const none = pages.create({ title: 'D', summary: '', ownerThread: 't', html: page('d'), ownerProjects: [proj('p_tb', true)], projects: [] });
  assert.deepEqual(none.projects, []);
  const asked = pages.create({ title: 'E', summary: '', ownerThread: 't', html: page('e'), projects: ['p_poddle', 'p_tb'] });
  assert.deepEqual(asked.projects.map((p) => p.id), ['p_poddle', 'p_tb']);
});

test('setProjects adds and removes, and list filters by project, thread and none', () => {
  const pages = new Pages(home());
  const a = pages.create({ title: 'A', summary: '', ownerThread: 't1', html: page('a'), projects: [] });
  pages.create({ title: 'B', summary: '', ownerThread: 't2', html: page('b'), projects: ['p_tb'] });
  pages.setProjects(a.id, { add: ['p_tb', 'p_poddle'] });
  assert.equal(pages.list({ project: 'p_poddle' }).length, 1);
  assert.equal(pages.list({ project: 'p_tb' }).length, 2);
  pages.setProjects(a.id, { remove: ['p_tb', 'p_poddle'] });
  assert.deepEqual(pages.list({ none: true }).map((p) => p.title), ['A']);
  assert.deepEqual(pages.list({ thread: 't2' }).map((p) => p.title), ['B']);
});

// The tools, against a fake runner that knows one thread pinned to a project.
type Tool = { name: string; description: string; handler: (a: never, e: never) => Promise<{ content: { text: string }[]; isError?: boolean }> };
const call = async (tools: Tool[], name: string, args: Record<string, unknown>) => {
  const r = await tools.find((t) => t.name === name)!.handler(args as never, {} as never);
  return { text: r.content[0]!.text, err: r.isError === true };
};

test('page tools: off without the experiment; create inherits the pinned project and update keeps one page', async () => {
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const h = home();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-page-cwd-'));
  const thread = { id: 'th1', title: 'Bundle', cwd, projects: [proj('p_tb', true)] };
  const control = { list: async () => [thread], get: async () => ({ ...thread, permissionMode: 'full' }) } as never;
  const projects = { find: async (q: string) => (q === 'Threadbear' || q === 'p_tb' ? { id: 'p_tb', title: 'Threadbear' } : undefined) } as never;
  const off = buildThreadbearTools(control, 'th1', Date.now, undefined, projects) as unknown as Tool[];
  assert.ok(!off.some((t) => t.name === 'create_print' || t.name === 'create_page'));

  const store = new Pages(h);
  const tools = buildThreadbearTools(control, 'th1', Date.now, undefined, projects, undefined, { pages: () => store }) as unknown as Tool[];
  const made = await call(tools, 'create_print', { title: 'Bundle size', summary: '20.22 MB', html: page('v1'), source: 'bundle-analyzer summary' });
  assert.equal(made.err, false, made.text);
  assert.match(made.text, /pg_bundle_size {2}print {2}v1 .*in p_tb/);
  const bad = await call(tools, 'create_print', { title: 'X', summary: '', html: page('<script></script>') });
  assert.equal(bad.err, true);

  fs.mkdirSync(path.join(cwd, 'out'));
  fs.writeFileSync(path.join(cwd, 'out', 'index.html'), page('v2'));
  const up = await call(tools, 'update_print', { id: 'pg_bundle', dir: 'out' });
  assert.match(up.text, /v2/);
  assert.match(fs.readFileSync(store.file('pg_bundle_size'), 'utf8'), /v2/);

  assert.match((await call(tools, 'list_prints', { project: 'Threadbear' })).text, /pg_bundle_size/);
  assert.equal((await call(tools, 'list_prints', { none: true })).text, 'No prints.');
  await call(tools, 'remove_print_from_project', { id: 'pg_bundle_size', project: 'Threadbear' });
  assert.match((await call(tools, 'read_print', { id: 'pg_bundle_size' })).text, /no project[\s\S]*file: .*v2\/index\.html/);
});

test('pages.* methods: empty while off, list, get with file and versions, setProjects as Mike, and a change notifies', async () => {
  const { pageMethods } = await import('../../src/pages.ts');
  const offM = pageMethods(() => undefined);
  assert.deepEqual(offM['pages.list']!({}), { pages: [] });
  assert.throws(() => offM['pages.get']!({ pageId: 'x' }), /Prints is off/);

  const seen: number[] = [];
  const store = new Pages(home(), Date.now, (list) => seen.push(list.length));
  const m = pageMethods(() => store);
  const p = store.create({ title: 'Bundle size', summary: 's', ownerThread: 't1', html: page('1'), projects: [] });
  store.update(p.id, { html: page('2') });
  assert.deepEqual(seen, [1, 1]);
  const got = m['pages.get']!({ pageId: 'pg_bundle' }) as { page: { version: number }; file: string; versions: number[] };
  assert.equal(got.page.version, 2);
  assert.deepEqual(got.versions, [1, 2]);
  assert.match(fs.readFileSync(got.file, 'utf8'), /2/);
  const moved = m['pages.setProjects']!({ pageId: p.id, add: ['p_tb'] }) as { page: { projects: { id: string; by: string }[] } };
  assert.deepEqual(moved.page.projects.map((x) => [x.id, x.by]), [['p_tb', 'mike']]);
  assert.equal((m['pages.list']!({ project: 'p_tb' }) as { pages: unknown[] }).pages.length, 1);
  assert.equal((m['pages.list']!({ none: true }) as { pages: unknown[] }).pages.length, 0);
  assert.throws(() => m['pages.get']!({ pageId: 'nope' }), /No print nope/);
  assert.throws(() => m['pages.setProjects']!({ pageId: p.id, add: 'p_tb' }), /list of strings/);
});

test('docs: markdown is drawn, kept beside it, edited by the user as a new version, and escaped', async () => {
  const store = new Pages(home());
  const d = store.create({ title: 'Launch plan', summary: '', ownerThread: 't', markdown: '# Goals\n\n- [x] ship **Pages**\n- [ ] write the guide\n\n<script>alert(1)</script>\n\n[site](https://convex.dev) [bad](javascript:alert(1))\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
  assert.equal(d.kind, 'doc');
  const html = fs.readFileSync(store.file(d.id), 'utf8');
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/convex.dev">site<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<li class="task done">/);
  assert.match(html, /<table>/);
  assert.match(store.markdown(d.id)!, /ship \*\*Pages\*\*/);
  const edited = store.update(d.id, { markdown: '# Goals\n\nDone.', by: 'user' });
  assert.equal(edited.version, 2);
  assert.equal(edited.editedBy, 'user');
  assert.equal(store.markdown(d.id), '# Goals\n\nDone.');
  assert.match(store.markdown(d.id, 1)!, /write the guide/);
  const renamed = store.update(d.id, { title: 'Launch plan v2' });
  assert.equal(renamed.version, 3, "a doc's title is in the page, so a new title is a new version");
  assert.match(fs.readFileSync(store.file(d.id), 'utf8'), /Launch plan v2/);
});

test('delete keeps a page 7 days for restore, then purges it with its files', () => {
  const h = home();
  let t = Date.parse('2026-11-10T00:00:00Z');
  const store = new Pages(h, () => t);
  const p = store.create({ title: 'Old', summary: '', ownerThread: 't', html: page('x'), projects: [] });
  store.delete(p.id);
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ deleted: true }).length, 1);
  assert.throws(() => store.update(p.id, { html: page('y') }), /deleted/);
  store.restore(p.id);
  assert.equal(store.list().length, 1);
  store.delete(p.id);
  t += 8 * 24 * 3600 * 1000;
  const later = new Pages(h, () => t);
  assert.equal(later.list({ deleted: true }).length, 0);
  assert.ok(!fs.existsSync(path.join(h, 'pages', p.id)));
});

test('restoreVersion makes an old version the newest again; exportTo copies a version into an empty folder', () => {
  const store = new Pages(home());
  const p = store.create({ title: 'V', summary: '', ownerThread: 't', html: page('one') });
  store.update(p.id, { html: page('two') });
  const back = store.restoreVersion(p.id, 1);
  assert.equal(back.version, 3);
  assert.match(fs.readFileSync(store.file(p.id), 'utf8'), /one/);
  assert.throws(() => store.restoreVersion(p.id, 9), /isn't kept/);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-export-')), 'out');
  const file = store.exportTo(p.id, dest, 2);
  assert.match(fs.readFileSync(file, 'utf8'), /two/);
  assert.throws(() => store.exportTo(p.id, dest), /already has files/);
});

test('pages.refresh and pages.edit send the page to a thread; the runner never runs the recipe', async () => {
  const { pageMethods, refreshText, editText } = await import('../../src/pages.ts');
  const store = new Pages(home());
  const p = store.create({ title: 'Bundle size', summary: '', ownerThread: 'th1', html: page('x'), recipe: 'node report.mjs ~/app out' });
  const sent: { id: string; text: string }[] = [];
  const m = pageMethods(() => store, (pg, text) => (sent.push({ id: pg.ownerThread, text }), { threadId: pg.ownerThread, started: false }));
  m['pages.refresh']!({ pageId: p.id });
  m['pages.edit']!({ pageId: p.id, text: 'make the bars amber' });
  assert.deepEqual(sent.map((x) => x.id), ['th1', 'th1']);
  assert.equal(sent[0]!.text, refreshText(store.find(p.id)));
  assert.match(sent[0]!.text, /How it was made: node report\.mjs/);
  assert.equal(sent[1]!.text, editText(store.find(p.id), 'make the bars amber'));
  assert.throws(() => m['pages.edit']!({ pageId: p.id, text: ' ' }), /what should change/);
  const doc = store.create({ title: 'Notes', summary: '', ownerThread: 'th1', markdown: 'hi' });
  m['pages.saveDoc']!({ pageId: doc.id, markdown: 'hello' });
  assert.equal((m['pages.get']!({ pageId: doc.id }) as { markdown: string }).markdown, 'hello');
  assert.equal(store.find(doc.id).editedBy, 'user');
  m['pages.delete']!({ pageId: doc.id });
  assert.equal((m['pages.list']!({ deleted: true }) as { pages: unknown[] }).pages.length, 1);
  m['pages.restore']!({ pageId: doc.id });
  assert.throws(() => m['pages.export']!({ pageId: doc.id, dest: 'relative' }), /absolute/);
});

test('the old page tool names still work after the rename to Prints', async () => {
  const { buildThreadbearTools, NEVER_ASK_TOOLS } = await import('../../src/threadbear-mcp.ts');
  const store = new Pages(home());
  const control = { list: async () => [{ id: 'th1', title: 't', cwd: os.tmpdir(), projects: [] }], get: async () => ({ permissionMode: 'full' }) } as never;
  const tools = buildThreadbearTools(control, 'th1', Date.now, undefined, undefined, undefined, { pages: () => store }) as unknown as Tool[];
  const names = tools.map((t) => t.name);
  for (const n of ['create_print', 'update_print', 'list_prints', 'read_print', 'delete_print', 'restore_print', 'export_print', 'add_print_to_project', 'remove_print_from_project']) assert.ok(names.includes(n), n);
  for (const n of ['create_page', 'update_page', 'list_pages', 'read_page', 'delete_page', 'restore_page', 'export_page', 'add_page_to_project', 'remove_page_from_project']) assert.ok(names.includes(n), n);
  const made = await call(tools, 'create_page', { title: 'Old name', summary: '', html: page('x') });
  assert.match(made.text, /Made pg_old_name/);
  assert.match(made.text, /```print pg_old_name```/, 'agents are told the print block');
  assert.match((await call(tools, 'list_prints', {})).text, /pg_old_name/);
  for (const n of ['list_prints', 'read_print', 'list_pages', 'read_page']) assert.ok(NEVER_ASK_TOOLS.has(`mcp__threadbear__${n}`), n);
});

test('publish: a link made once, new versions follow, live and scripted prints refused, delete takes it down', async () => {
  const { publishPage, unpublishPage, followPublished, printLink, PUBLISH_HTML_MAX } = await import('../../src/pages.ts');
  const sent: { id: string; slug: string; version: number; html: string }[] = [];
  const down: string[] = [];
  let problem: string | undefined;
  const pub = { problem: () => problem, site: () => 'https://x.convex.site/', publish: async (p: never) => void sent.push(p), unpublish: async (id: string) => void down.push(id) };
  const known = new Map<string, string>();
  const store = new Pages(home());
  const p = store.create({ title: 'Sales', summary: 's', ownerThread: 't', html: page('one'), projects: [] });
  const first = await publishPage(store, pub, p.id);
  const slug = first.page.published!.slug;
  assert.match(slug, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(first.url, `https://x.convex.site/p/${slug}`);
  assert.equal(printLink(undefined, slug), undefined);
  assert.match(sent[0]!.html, /one/);

  store.update(p.id, { html: page('two') });
  await followPublished(store, pub, known);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.slug, slug, 'the link survives a new version');
  assert.equal(sent[1]!.version, 2);
  await followPublished(store, pub, known);
  assert.equal(sent.length, 2, 'nothing to send when the newest is up');

  const live = store.create({ title: 'Live', summary: '', ownerThread: 't', html: page('<script>1</script>'), live: true });
  await assert.rejects(publishPage(store, pub, live.id), /scripts/);
  assert.equal(store.find(live.id).published, undefined);
  const big = store.create({ title: 'Big', summary: '', ownerThread: 't', html: page('x'.repeat(PUBLISH_HTML_MAX)) });
  await assert.rejects(publishPage(store, pub, big.id), /at most/);

  problem = 'The backend is too old';
  const other = store.create({ title: 'Other', summary: '', ownerThread: 't', html: page('o') });
  await assert.rejects(publishPage(store, pub, other.id), /too old/);
  problem = undefined;

  store.delete(p.id);
  await followPublished(store, pub, known);
  assert.deepEqual(down, [p.id]);
  assert.equal(store.list({ deleted: true })[0]!.published, undefined);

  const again = await publishPage(store, pub, other.id);
  assert.equal((await unpublishPage(store, pub, other.id)).published, undefined);
  assert.ok(again.page.published);
});

test('only when asked: create_print after a message that asks for no print puts a card up first', async () => {
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const thread = { id: 'th1', title: 'Work', cwd: home(), projects: [] };
  let said = 'Fix the login bug';
  const cards: string[] = [];
  let answer: 'allow' | 'deny' = 'deny';
  const control = {
    list: async () => [thread],
    get: async () => ({ ...thread, permissionMode: 'full' }),
    events: async () => ({ firstSeq: 1, events: [{ seq: 1, type: 'user.message', text: said, images: [] }, { seq: 2, type: 'turn.started' }] }),
    requestAgentApproval: async (_id: string, req: { title: string }) => { cards.push(req.title); return { decision: answer }; },
  } as never;
  const store = new Pages(home());
  let on = true;
  const tools = buildThreadbearTools(control, 'th1', Date.now, undefined, undefined, undefined, { pages: () => store, printsWhenAsked: () => on }) as unknown as Tool[];
  assert.match(tools.find((t) => t.name === 'create_print')!.description, /only when the user asks/i);

  const denied = await call(tools, 'create_print', { title: 'Progress', summary: '', html: page('a') });
  assert.equal(denied.err, true);
  assert.match(denied.text, /said no/);
  assert.match(cards[0]!, /Make the print "Progress"\? You asked to approve Prints you didn't ask for/);
  assert.equal(store.list().length, 0);

  answer = 'allow';
  assert.equal((await call(tools, 'create_print', { title: 'Progress', summary: '', html: page('a') })).err, false);
  assert.equal(cards.length, 2);

  said = 'Make a pie chart of this spreadsheet';
  assert.equal((await call(tools, 'create_print', { title: 'Regions', summary: '', html: page('b') })).err, false);
  said = 'Draw this flow as a diagram';
  assert.equal((await call(tools, 'create_print', { title: 'Flow', summary: '', mermaid: 'flowchart LR\n A --> B' })).err, false);
  assert.equal(cards.length, 2, 'asked for, so no card');

  on = false;
  said = 'Fix the login bug';
  assert.equal((await call(tools, 'create_print', { title: 'Notes', summary: '', html: page('c') })).err, false);
  assert.equal(cards.length, 2, 'setting off, so no card');
  const plain = buildThreadbearTools(control, 'th1', Date.now, undefined, undefined, undefined, { pages: () => store }) as unknown as Tool[];
  assert.doesNotMatch(plain.find((t) => t.name === 'create_print')!.description, /only when the user asks/i);
});

test('only when asked: the words that count as asking for a print', async () => {
  const { asksForPrint } = await import('../../src/threadbear-mcp.ts');
  for (const s of ['make a print of it', 'Prints please', 'a bar CHART', 'graph the latency', 'build a dashboard', 'diagrams of the flow']) assert.ok(asksForPrint(s), s);
  for (const s of ['fix the page header', 'write the docs', 'report back when done', 'blueprint', 'printf debugging', 'chartreuse button', '']) assert.ok(!asksForPrint(s), s);
});

test('only when asked: off unless runner.json turns it on, and settings.update saves it at once', async () => {
  const { loadConfig } = await import('../../src/config.ts');
  const { SettingsService, settingsMethods } = await import('../../src/settings.ts');
  const h = home();
  const cfg = loadConfig({ THREADBEAR_HOME: h });
  assert.equal(cfg.printsWhenAsked, false, 'off with nothing in runner.json');
  const s = new SettingsService({ config: cfg, publish: () => {} });
  assert.equal(s.get().printsWhenAsked, false);
  const rpc = settingsMethods(s);
  assert.equal((rpc['settings.update']!({ printsWhenAsked: true }) as { settings: { printsWhenAsked: boolean } }).settings.printsWhenAsked, true);
  assert.equal(cfg.printsWhenAsked, true, 'applies at once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'runner.json'), 'utf8')).printsWhenAsked, true, 'saved');
  assert.equal(loadConfig({ THREADBEAR_HOME: h }).printsWhenAsked, true, 'read back');
  assert.throws(() => rpc['settings.update']!({ printsWhenAsked: 'yes' }), /printsWhenAsked must be a boolean/);
});
