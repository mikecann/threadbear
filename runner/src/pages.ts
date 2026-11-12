// Prints (the pages experiment; "Pages" until 10 Nov 2026, and the code and
// protocol still say page): a named, versioned page a thread makes for
// the user, like a bundle size report or a progress card. It outlives the
// reply it was posted in and can be updated in place. Unlike a pin, the
// runner keeps it, so it can belong to zero, one or several projects the
// way a thread can, whatever folder the thread ran in.
//
// Kept in <home>/pages: index.json for the records, and one folder per
// version, <id>/v<n>/, with index.html and the assets it names. Only the
// newest MAX_VERSIONS are kept.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import type { ProjectMaker, ThreadProject } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import { DOC_SOURCE, renderDoc } from './page-doc.ts';
import { DIAGRAM_SOURCE, renderDiagram } from './page-diagram.ts';

export const MAX_VERSIONS = 10;
export const MAX_HTML_BYTES = 1_000_000;
// Room for one short MP4 clip next to the page.
export const MAX_PAGE_BYTES = 25_000_000;
export const MAX_SUMMARY = 280;
export const MAX_TITLE = 120;
// What a page folder may hold besides index.html: passive assets only.
// No .js (scripts live inline, and only on live pages) and no .json (a
// page can't read data files; that's for a later host channel).
export const PAGE_ASSETS = new Set(['.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.woff2', '.md', '.mmd']);
export const MAX_RECIPE = 1000;
// The backend's cap on a published print's HTML (convex/sync.ts PRINT_HTML_MAX).
export const PUBLISH_HTML_MAX = 700_000;
// A deleted page is kept this long so Restore can bring it back.
export const DELETED_KEEP_MS = 7 * 24 * 3600 * 1000;
// What a page is, for its icon and what Refresh and Edit mean. A doc is
// markdown the runner draws (page-doc.ts), which the user can edit too.
export const PAGE_KINDS = ['page', 'chart', 'dashboard', 'report', 'doc', 'diagram', 'bundle'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export type PageProject = { id: string; by: ProjectMaker; pinned?: boolean };

export type PageRecord = {
  id: string;
  title: string;
  summary: string;
  ownerThread: string;
  projects: PageProject[];
  version: number;
  bytes: number;
  // Scripts allowed: they run only in the side pane, after the user's
  // "Run them" for that exact file. Static pages are refused any.
  live: boolean;
  // What made it, so the same report updates rather than piles up
  // ("bundle-analyzer summary").
  source?: string;
  // Left out on pages from before kinds: "page".
  kind?: PageKind;
  // How to make it again, in words an agent can follow (the command, the
  // data file), for Refresh. Never run by the runner itself.
  recipe?: string;
  // Who wrote the newest version: an agent, or the user in the editor.
  editedBy?: 'agent' | 'user';
  // Set while it's published (docs/protocol.md, "Prints"): its link's
  // slug, made here, and the version last sent to the backend.
  published?: { slug: string; at: string; version: number };
  // Set while it's deleted; gone for good DELETED_KEEP_MS later.
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

// One of: HTML, a built folder, Markdown for a doc, or Mermaid for a diagram.
export type PageContent = { html?: string; dir?: string; markdown?: string; mermaid?: string };

export type CreatePage = PageContent & {
  title: string;
  summary: string;
  ownerThread: string;
  // Left out: the page joins the owner thread's project when it's pinned
  // to exactly one. [] always means no project.
  projects?: string[];
  ownerProjects?: readonly ThreadProject[];
  source?: string;
  live?: boolean;
  kind?: PageKind;
  recipe?: string;
};

export type UpdatePage = PageContent & { title?: string; summary?: string; recipe?: string; by?: 'agent' | 'user' };

export type PageFilter = { project?: string; thread?: string; none?: boolean; source?: string; deleted?: boolean };

const SCRIPT = /<script\b/i;

export class PageError extends Error {}

export class Pages {
  readonly dir: string;
  private readonly now: () => number;
  private readonly onChange: ((pages: PageRecord[]) => void) | undefined;
  private records: PageRecord[];

  // onChange: every change, with the whole list, for pages.updated.
  constructor(home: string, now: () => number = Date.now, onChange?: (pages: PageRecord[]) => void) {
    this.dir = path.join(home, 'pages');
    this.now = now;
    this.onChange = onChange;
    this.records = readJsonSync<PageRecord[]>(this.indexFile()) ?? [];
    this.purge();
  }

  // Deleted pages are left out unless asked for (then only they come back).
  list(f: PageFilter = {}): PageRecord[] {
    return this.records
      .filter((p) => (f.deleted ? Boolean(p.deletedAt) : !p.deletedAt))
      .filter((p) => (f.thread ? p.ownerThread === f.thread : true))
      .filter((p) => (f.project ? p.projects.some((x) => x.id === f.project) : true))
      .filter((p) => (f.none ? p.projects.length === 0 : true))
      .filter((p) => (f.source ? p.source === f.source : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): PageRecord | undefined {
    return this.records.find((p) => p.id === id);
  }

  // The page the side pane opens: the newest version's index.html.
  file(id: string, version?: number): string {
    const p = this.must(id);
    return path.join(this.versionDir(p.id, version ?? p.version), 'index.html');
  }

  create(c: CreatePage): PageRecord {
    const title = cleanTitle(c.title);
    const at = new Date(this.now()).toISOString();
    const id = this.newId(title);
    const live = c.mermaid === undefined && c.live === true;
    const projects = c.projects
      ? [...new Set(c.projects)].map((pid): PageProject => ({ id: pid, by: 'agent', pinned: true }))
      : inherited(c.ownerProjects ?? []);
    const kind = c.mermaid !== undefined ? 'diagram' : c.markdown !== undefined ? 'doc' : (c.kind ?? 'page');
    const bytes = this.write(id, 1, c, live, title);
    const rec: PageRecord = {
      id,
      title,
      summary: cleanSummary(c.summary),
      ownerThread: c.ownerThread,
      projects,
      version: 1,
      bytes,
      live,
      ...(c.source ? { source: c.source.trim().slice(0, MAX_TITLE) } : {}),
      kind,
      ...(c.recipe?.trim() ? { recipe: c.recipe.trim().slice(0, MAX_RECIPE) } : {}),
      editedBy: 'agent',
      createdAt: at,
      updatedAt: at,
    };
    this.records.push(rec);
    this.persist();
    return rec;
  }

  update(id: string, u: UpdatePage): PageRecord {
    const p = this.live(id);
    const next = { ...p };
    if (u.title !== undefined) next.title = cleanTitle(u.title);
    if (u.summary !== undefined) next.summary = cleanSummary(u.summary);
    if (u.recipe !== undefined) next.recipe = u.recipe.trim().slice(0, MAX_RECIPE) || undefined;
    if (u.html !== undefined || u.dir !== undefined || u.markdown !== undefined || u.mermaid !== undefined) {
      if (u.markdown !== undefined) next.kind = 'doc';
      // Script permission belongs to the Print, not its current format.
      // Keeping it lets a live Print restore its older scripted versions.
      if (u.mermaid !== undefined || (u.dir && fs.existsSync(path.join(u.dir, DIAGRAM_SOURCE)))) next.kind = 'diagram';
      else if (u.dir && fs.existsSync(path.join(u.dir, DOC_SOURCE))) next.kind = 'doc';
      else if (u.markdown === undefined && (next.kind === 'doc' || next.kind === 'diagram')) next.kind = 'page';
      next.version = p.version + 1;
      next.bytes = this.write(p.id, next.version, u, p.live, next.title);
      next.editedBy = u.by ?? 'agent';
      this.prune(p.id, next.version);
    } else if (u.title !== undefined && (next.kind === 'doc' || next.kind === 'diagram')) {
      // The title is drawn into source-based Prints, so rename versions it too.
      const md = this.markdown(p.id);
      const mermaid = this.mermaid(p.id);
      const content = next.kind === 'diagram' && mermaid !== undefined ? { mermaid } : md !== undefined ? { markdown: md } : undefined;
      if (content) {
        next.version = p.version + 1;
        next.bytes = this.write(p.id, next.version, content, p.live, next.title);
        this.prune(p.id, next.version);
      }
    }
    next.updatedAt = new Date(this.now()).toISOString();
    this.records = this.records.map((r) => (r.id === p.id ? next : r));
    this.persist();
    return next;
  }

  // A doc's markdown, newest or at a version, for the editor.
  markdown(id: string, version?: number): string | undefined {
    const p = this.must(id);
    try {
      return fs.readFileSync(path.join(this.versionDir(p.id, version ?? p.version), DOC_SOURCE), 'utf8');
    } catch {
      return undefined;
    }
  }

  mermaid(id: string, version?: number): string | undefined {
    const p = this.must(id);
    try {
      return fs.readFileSync(path.join(this.versionDir(p.id, version ?? p.version), DIAGRAM_SOURCE), 'utf8');
    } catch {
      return undefined;
    }
  }

  // An older version becomes the newest again, as a new version, so
  // nothing in between is lost.
  restoreVersion(id: string, version: number): PageRecord {
    const p = this.live(id);
    const from = this.versionDir(p.id, version);
    if (!fs.existsSync(from)) throw new PageError(`Version ${version} of ${p.id} isn't kept. read_print lists the versions there are.`);
    return this.update(p.id, { dir: from });
  }

  // Marks it published under a link (a new one only the first time, so a
  // link survives new versions), or not published.
  setPublished(id: string, on: boolean, sentVersion?: number): PageRecord {
    const p = this.live(id);
    if (!on) {
      const { published: _was, ...rest } = p;
      return this.replace(rest);
    }
    const slug = p.published?.slug ?? crypto.randomBytes(16).toString('base64url');
    return this.replace({ ...p, published: { slug, at: new Date(this.now()).toISOString(), version: sentVersion ?? p.version } });
  }

  // What publishing sends: the newest version's index.html. Refused for a
  // live print (its scripts would run for anyone with the link), one over
  // the backend's size, and one that leans on files beside it.
  publishable(id: string): { html: string } {
    const p = this.live(id);
    if (p.live) throw new PageError('A live print has scripts, so it can not be published. Make a static one.');
    const html = fs.readFileSync(this.file(p.id), 'utf8');
    if (SCRIPT.test(html)) throw new PageError('This print has a script, so it can not be published.');
    if (html.length > PUBLISH_HTML_MAX) throw new PageError(`This print is ${html.length} characters; at most ${PUBLISH_HTML_MAX} can be published.`);
    return { html };
  }

  // Set aside for DELETED_KEEP_MS, then gone. Lists leave it out.
  delete(id: string): PageRecord {
    const p = this.live(id);
    const { published: _was, ...rest } = p;
    return this.replace({ ...rest, deletedAt: new Date(this.now()).toISOString() });
  }

  restore(id: string): PageRecord {
    const p = this.must(id);
    if (!p.deletedAt) return p;
    const { deletedAt: _gone, ...rest } = p;
    return this.replace({ ...rest, updatedAt: new Date(this.now()).toISOString() });
  }

  // Copies a version's files into dest (made if missing, refused if it
  // has files), for Download. Returns the copied index.html.
  exportTo(id: string, dest: string, version?: number): string {
    const p = this.must(id);
    const from = this.versionDir(p.id, version ?? p.version);
    if (!fs.existsSync(from)) throw new PageError(`Version ${version} of ${p.id} isn't kept.`);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new PageError(`${dest} already has files in it. Pick an empty or new folder.`);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(from, dest, { recursive: true });
    return path.join(dest, 'index.html');
  }

  setProjects(id: string, change: { add?: string[]; remove?: string[]; by?: ProjectMaker }): PageRecord {
    const p = this.live(id);
    const remove = new Set(change.remove ?? []);
    const kept = p.projects.filter((x) => !remove.has(x.id));
    const have = new Set(kept.map((x) => x.id));
    const added = (change.add ?? []).filter((x) => !have.has(x)).map((x): PageProject => ({ id: x, by: change.by ?? 'agent', pinned: true }));
    const next = { ...p, projects: [...kept, ...added], updatedAt: new Date(this.now()).toISOString() };
    this.records = this.records.map((r) => (r.id === p.id ? next : r));
    this.persist();
    return next;
  }

  // By id or a unique prefix, or a PageError saying how to find one.
  find(id: string): PageRecord {
    return this.must(id);
  }

  private replace(next: PageRecord): PageRecord {
    this.records = this.records.map((r) => (r.id === next.id ? next : r));
    this.persist();
    return next;
  }

  // Pages deleted over DELETED_KEEP_MS ago, removed with their files.
  private purge(): void {
    const cut = this.now() - DELETED_KEEP_MS;
    const gone = this.records.filter((p) => p.deletedAt && Date.parse(p.deletedAt) < cut);
    if (!gone.length) return;
    for (const p of gone) fs.rmSync(path.join(this.dir, p.id), { recursive: true, force: true });
    const ids = new Set(gone.map((p) => p.id));
    this.records = this.records.filter((p) => !ids.has(p.id));
    atomicWriteFileSync(this.indexFile(), JSON.stringify(this.records, null, 2) + '\n');
  }

  // A page that isn't deleted, for anything that changes it.
  private live(id: string): PageRecord {
    const p = this.must(id);
    if (p.deletedAt) throw new PageError(`${p.id} is deleted. restore_print brings it back first.`);
    return p;
  }

  private must(id: string): PageRecord {
    const p = this.get(id) ?? this.records.find((r) => r.id.startsWith(id));
    if (!p) throw new PageError(`No print ${id}. list_prints shows them.`);
    return p;
  }

  private newId(title: string): string {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'page';
    let id = `pg_${slug}`;
    while (this.get(id)) id = `pg_${slug}_${crypto.randomBytes(2).toString('hex')}`;
    return id;
  }

  private versionDir(id: string, v: number): string {
    return path.join(this.dir, id, `v${v}`);
  }

  // Checks everything before anything is written, then copies into a temp
  // folder and renames it into place, so a refused page leaves nothing.
  private write(id: string, v: number, c: PageContent, live: boolean, title: string): number {
    const given = [c.html, c.dir, c.markdown, c.mermaid].filter((x) => x !== undefined).length;
    if (given !== 1) throw new PageError('Give the print as html, dir, markdown or mermaid, one of them.');
    const at = new Date(this.now());
    let diagram: { html: string; svg: string } | undefined;
    if (c.mermaid !== undefined) {
      try {
        diagram = renderDiagram(title, c.mermaid, `Version ${v} · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      } catch (error) {
        throw new PageError(error instanceof Error ? error.message : 'Could not render the diagram.');
      }
    }
    const files: { rel: string; data: Buffer }[] =
      diagram
        ? [{ rel: 'index.html', data: Buffer.from(diagram.html) }, { rel: DIAGRAM_SOURCE, data: Buffer.from(c.mermaid!) }, { rel: 'diagram.svg', data: Buffer.from(diagram.svg) }]
        : c.markdown !== undefined
        ? [
            { rel: 'index.html', data: Buffer.from(renderDoc(title, c.markdown, `Version ${v} · ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`), 'utf8') },
            { rel: DOC_SOURCE, data: Buffer.from(c.markdown, 'utf8') },
          ]
        : c.html !== undefined
          ? [{ rel: 'index.html', data: Buffer.from(c.html, 'utf8') }]
          : readPageDir(c.dir!);
    const index = files.find((f) => f.rel === 'index.html');
    if (!index) throw new PageError(`${c.dir} has no index.html.`);
    if (index.data.length > MAX_HTML_BYTES) throw new PageError(`index.html is ${index.data.length} bytes; the most is ${MAX_HTML_BYTES}. Move pictures into files next to it.`);
    const total = files.reduce((n, f) => n + f.data.length, 0);
    if (total > MAX_PAGE_BYTES) throw new PageError(`The print is ${total} bytes; the most is ${MAX_PAGE_BYTES}.`);
    if (!live) {
      for (const f of files) {
        if (f.rel.endsWith('.html') && SCRIPT.test(f.data.toString('utf8'))) {
          throw new PageError(`${f.rel} has a <script>. Prints are static unless made with live: true; draw with HTML, CSS and SVG instead.`);
        }
      }
    }
    const dest = this.versionDir(id, v);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      const to = path.join(tmp, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    return total;
  }

  private prune(id: string, newest: number): void {
    for (let v = newest - MAX_VERSIONS; v >= 1; v--) {
      const d = this.versionDir(id, v);
      if (!fs.existsSync(d)) break;
      fs.rmSync(d, { recursive: true, force: true });
    }
  }

  private indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  // The versions still on disk, oldest first.
  versions(id: string): number[] {
    const p = this.must(id);
    const out: number[] = [];
    for (let v = Math.max(1, p.version - MAX_VERSIONS + 1); v <= p.version; v++) if (fs.existsSync(this.versionDir(p.id, v))) out.push(v);
    return out;
  }

  private persist(): void {
    atomicWriteFileSync(this.indexFile(), JSON.stringify(this.records, null, 2) + '\n');
    this.onChange?.(this.list());
  }
}

// One pinned project, and the page goes there too; a thread in several, or
// only guessed into one by the librarian, leaves the page in none.
function inherited(ps: readonly ThreadProject[]): PageProject[] {
  const pinned = ps.filter((p) => p.pinned);
  return pinned.length === 1 ? [{ id: pinned[0]!.id, by: 'agent' }] : [];
}

function cleanTitle(t: string): string {
  const s = t.trim().slice(0, MAX_TITLE);
  if (!s) throw new PageError('A print needs a title.');
  return s;
}

function cleanSummary(t: string): string {
  return t.trim().slice(0, MAX_SUMMARY);
}

// Every file under dir, refusing links and anything not on PAGE_ASSETS, so
// a page can't carry scripts or data files in beside it.
export function readPageDir(dir: string): { rel: string; data: Buffer }[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new PageError(`No folder ${dir}.`);
  }
  if (!st.isDirectory()) throw new PageError(`${dir} isn't a folder.`);
  const out: { rel: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full);
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) throw new PageError(`${rel} is a link. Copy the file in instead.`);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (!PAGE_ASSETS.has(path.extname(e.name).toLowerCase())) throw new PageError(`${rel} can't go in a print. Allowed: ${[...PAGE_ASSETS].join(' ')}.`);
        out.push({ rel, data: fs.readFileSync(full) });
      }
    }
  };
  walk(dir);
  return out;
}

// What Refresh and Edit with agent send: a message to the thread that made
// the page, or a new thread when that one's gone. The runner never runs a
// recipe itself; an agent reads it and does the work, under the thread's
// own permissions.
export function refreshText(p: PageRecord): string {
  const how = p.recipe ? `How it was made: ${p.recipe}` : 'Make it again from the same source as before.';
  return `Refresh the print "${p.title}" (${p.id}). ${how} Then call update_print with id ${p.id}${p.kind === 'doc' ? ' and the new markdown' : ''}.`;
}

export function editText(p: PageRecord, change: string): string {
  return `Change the print "${p.title}" (${p.id}): ${change.trim()}\n\nCall update_print with id ${p.id}${p.kind === 'doc' ? ' and the new markdown (read_print has the current markdown)' : ''} when it's done.`;
}

export type PageAsk = (page: PageRecord, text: string) => { threadId: string; started: boolean };

// What publishing needs from the Convex mirror (sync.ts), and the website
// a link is on.
export type PagePublisher = {
  problem(): string | undefined;
  site(): string | undefined;
  publish(print: { id: string; slug: string; title: string; kind: string; version: number; summary: string; html: string; updatedAt: string }): Promise<void>;
  unpublish(id: string): Promise<void>;
};

export function printLink(site: string | undefined, slug: string): string | undefined {
  return site ? `${site.replace(/\/+$/, '')}/p/${slug}` : undefined;
}

// Sends a print's newest version and marks it published, or takes it down.
export async function publishPage(pages: Pages, pub: PagePublisher, id: string): Promise<{ page: PageRecord; url?: string }> {
  const problem = pub.problem();
  if (problem) throw new PageError(problem);
  const p = pages.find(id);
  const { html } = pages.publishable(p.id);
  const marked = pages.setPublished(p.id, true);
  try {
    await pub.publish({ id: marked.id, slug: marked.published!.slug, title: marked.title, kind: marked.kind ?? 'page', version: marked.version, summary: marked.summary, html, updatedAt: marked.updatedAt });
  } catch (e) {
    // Never marked published when nothing went up.
    if (!p.published) pages.setPublished(p.id, false);
    throw e;
  }
  const url = printLink(pub.site(), marked.published!.slug);
  return { page: marked, ...(url ? { url } : {}) };
}

export async function unpublishPage(pages: Pages, pub: PagePublisher, id: string): Promise<PageRecord> {
  const p = pages.find(id);
  await pub.unpublish(p.id);
  return p.published ? pages.setPublished(p.id, false) : p;
}

// After any change: a published print whose newest version isn't the one
// sent goes up again, and one deleted while published comes down. Returns
// what it did, for the log; failures are left for the next change.
export async function followPublished(pages: Pages, pub: PagePublisher, known: Map<string, string>): Promise<void> {
  if (pub.problem()) return;
  const live = new Set<string>();
  for (const p of pages.list()) {
    if (!p.published) continue;
    live.add(p.id);
    known.set(p.id, p.published.slug);
    if (p.published.version === p.version) continue;
    try {
      await publishPage(pages, pub, p.id);
    } catch {
      // A new version that can't be published (too big, a script) leaves
      // the last published one up.
    }
  }
  for (const id of [...known.keys()]) {
    if (live.has(id)) continue;
    known.delete(id);
    await pub.unpublish(id).catch(() => {});
  }
}

// docs/protocol.md, "Prints". `pages` is undefined while the experiment is
// off: lists come back empty and the rest say so. `ask` sends Refresh and
// Edit with agent to a thread.
export function pageMethods(pages: () => Pages | undefined, ask?: PageAsk, pub?: PagePublisher): Record<string, (p: Record<string, unknown>) => unknown> {
  const must = (): Pages => {
    const s = pages();
    if (!s) throw new RpcError(ErrorCode.badParams, 'Prints is off. Turn it on in Settings > General > Experiments.');
    return s;
  };
  const str = (p: Record<string, unknown>, k: string): string | undefined => {
    const v = p[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new RpcError(ErrorCode.badParams, `${k} must be a string`);
    return v;
  };
  const list = (p: Record<string, unknown>, k: string): string[] | undefined => {
    const v = p[k];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RpcError(ErrorCode.badParams, `${k} must be a list of strings`);
    return v as string[];
  };
  const id = (p: Record<string, unknown>): string => {
    const v = str(p, 'pageId');
    if (!v) throw new RpcError(ErrorCode.badParams, 'pageId is required');
    return v;
  };
  const found = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof PageError) throw new RpcError(ErrorCode.badParams, e.message);
      throw e;
    }
  };
  return {
    'pages.list': (p) => {
      const s = pages();
      if (!s) return { pages: [] };
      const project = str(p, 'project');
      const thread = str(p, 'thread');
      return { pages: s.list({ ...(project ? { project } : {}), ...(thread ? { thread } : {}), ...(p.none === true ? { none: true } : {}), ...(p.deleted === true ? { deleted: true } : {}) }) };
    },
    'pages.get': (p) =>
      found(() => {
        const s = must();
        const page = s.find(id(p));
        const version = typeof p.version === 'number' ? p.version : undefined;
        const markdown = s.markdown(page.id, version);
        const mermaid = s.mermaid(page.id, version);
        return { page, file: s.file(page.id, version), versions: s.versions(page.id), ...(markdown !== undefined ? { markdown } : {}), ...(mermaid !== undefined ? { mermaid } : {}) };
      }),
    'pages.saveDoc': (p) => {
      const markdown = str(p, 'markdown');
      if (markdown === undefined) throw new RpcError(ErrorCode.badParams, 'markdown is required');
      const title = str(p, 'title');
      return found(() => ({ page: must().update(id(p), { markdown, by: 'user', ...(title ? { title } : {}) }) }));
    },
    'pages.saveDiagram': (p) => {
      const mermaid = str(p, 'mermaid');
      if (mermaid === undefined) throw new RpcError(ErrorCode.badParams, 'mermaid is required');
      return found(() => ({ page: must().update(id(p), { mermaid, by: 'user' }) }));
    },
    'pages.restoreVersion': (p) => {
      if (typeof p.version !== 'number') throw new RpcError(ErrorCode.badParams, 'version is required');
      return found(() => ({ page: must().restoreVersion(id(p), p.version as number) }));
    },
    'pages.delete': (p) => found(() => ({ page: must().delete(id(p)) })),
    'pages.restore': (p) => found(() => ({ page: must().restore(id(p)) })),
    'pages.export': (p) => {
      const dest = str(p, 'dest');
      if (!dest || !path.isAbsolute(dest)) throw new RpcError(ErrorCode.badParams, 'dest must be an absolute folder');
      const version = typeof p.version === 'number' ? p.version : undefined;
      return found(() => ({ file: must().exportTo(id(p), dest, version) }));
    },
    'pages.publish': async (p) => {
      if (!pub) throw new RpcError(ErrorCode.badParams, "This runner can't publish.");
      try {
        return await publishPage(must(), pub, id(p));
      } catch (e) {
        throw new RpcError(ErrorCode.badParams, (e as Error).message);
      }
    },
    'pages.unpublish': async (p) => {
      if (!pub) throw new RpcError(ErrorCode.badParams, "This runner can't publish.");
      try {
        return { page: await unpublishPage(must(), pub, id(p)) };
      } catch (e) {
        throw new RpcError(ErrorCode.badParams, (e as Error).message);
      }
    },
    'pages.refresh': (p) =>
      found(() => {
        if (!ask) throw new RpcError(ErrorCode.badParams, "This runner can't send a print to a thread.");
        const page = must().find(id(p));
        return ask(page, refreshText(page));
      }),
    'pages.edit': (p) => {
      const change = str(p, 'text');
      if (!change?.trim()) throw new RpcError(ErrorCode.badParams, 'text is required: what should change');
      return found(() => {
        if (!ask) throw new RpcError(ErrorCode.badParams, "This runner can't send a print to a thread.");
        const page = must().find(id(p));
        return ask(page, editText(page, change));
      });
    },
    'pages.setProjects': (p) => {
      const add = list(p, 'add');
      const remove = list(p, 'remove');
      return found(() => ({ page: must().setProjects(id(p), { ...(add ? { add } : {}), ...(remove ? { remove } : {}), by: 'mike' }) }));
    },
  };
}
