// Skills (docs/protocol.md, "Skills"): agent skills Threadbear keeps for
// every thread, on every login. The store is <data dir>/skills/: the list
// in skills.json, each skill's files in <name>@<commit 7>/ as fetched, and
// plugin/, a Claude Code plugin made from them that every Claude session
// gets. Codex reads $CODEX_HOME/skills, one home per login, so each skill's
// plugin folder is linked there too. Nothing fetched is ever run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Account } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { Notification } from './runner.ts';
import type { Logger } from './log.ts';

export type SkillSource =
  | { kind: 'github'; repo: string; ref?: string; path?: string; url: string }
  | { kind: 'builtin' };

export type Skill = {
  name: string;
  description: string;
  always: boolean;
  source: SkillSource;
  commit: string;
  dir: string;
  addedAt: string;
};

export type SuggestedSkill = { id: string; name: string; description: string; url?: string };

/** Suggested skills from outside, each until it's added (the built-in ones are suggested too). */
export const SUGGESTED: { id: string; name: string; description: string; url: string }[] = [
  {
    id: 'anatomy',
    name: 'anatomy',
    description: 'Interactive isometric figures of how a machine or mechanism works, by Ryan (MIT).',
    url: 'https://github.com/wheresryan22/anatomy',
  },
];

/** Where the built-in skills are, beside src/. */
export const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// MARK: Links

export type GitHubTarget = { repo: string; ref?: string; path?: string };

/**
 * A GitHub repo, folder, SKILL.md or raw file, or `owner/repo`, as a repo,
 * ref and path. Null for anything else (a page to read for one instead).
 */
export function parseGitHubLink(input: string): GitHubTarget | null {
  const text = input.trim().replace(/\/+$/, '');
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
  if (short) return { repo: `${short[1]}/${stripGit(short[2])}` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    if (parts.length < 2) return null;
    const repo = `${parts[0]}/${stripGit(parts[1])}`;
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
      let rest = parts.slice(4).join('/');
      if (/(^|\/)SKILL\.md$/i.test(rest)) rest = path.posix.dirname(rest) === '.' ? '' : path.posix.dirname(rest);
      return { repo, ref: parts[3], ...(rest ? { path: rest } : {}) };
    }
    return { repo };
  }
  if (url.hostname === 'raw.githubusercontent.com' && parts.length >= 3) {
    let rest = parts.slice(3).join('/');
    if (/(^|\/)SKILL\.md$/i.test(rest)) rest = path.posix.dirname(rest) === '.' ? '' : path.posix.dirname(rest);
    return { repo: `${parts[0]}/${parts[1]}`, ref: parts[2], ...(rest ? { path: rest } : {}) };
  }
  return null;
}

function stripGit(name: string): string {
  return name.replace(/\.git$/, '');
}

/** The skill a page names: its `npx skills add owner/repo` line, else its first GitHub repo link. */
export function findSkillInPage(html: string): GitHubTarget | null {
  const npx = /npx\s+(?:-y\s+)?skills(?:@[\w.-]+)?\s+add\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(html);
  if (npx) return { repo: stripGit(npx[1]) };
  const links = html.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^\s"'<>)]*)?/g);
  for (const m of links) {
    if (['sponsors', 'orgs', 'topics', 'features', 'about', 'login'].includes(m[1])) continue;
    const parsed = parseGitHubLink(m[0]);
    if (parsed) return parsed;
  }
  return null;
}

// MARK: SKILL.md

export type Frontmatter = { name?: string; description?: string };

/** The name and description in a SKILL.md's frontmatter. */
export function readFrontmatter(text: string): Frontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Frontmatter = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    // A folded or literal block: the indented lines after it.
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    value = value.replace(/^["']|["']$/g, '');
    out[kv[1] as 'name' | 'description'] = value;
  }
  return out;
}

/** The SKILL.md as the plugin gives it: `disable-model-invocation: true` when it's slash-only. */
export function pluginSkillText(text: string, always: boolean): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return always ? text : `---\ndisable-model-invocation: true\n---\n\n${text}`;
  const body = m[1].split(/\r?\n/).filter((l) => !/^disable-model-invocation:/.test(l));
  if (!always) body.push('disable-model-invocation: true');
  return `---\n${body.join('\n')}\n---` + text.slice(m[0].length);
}

/** Codex's agents/openai.yaml for a slash-only skill, keeping what the skill's own has. */
export function codexPolicy(existing: string | null, always: boolean): string | null {
  const stripped = (existing ?? '')
    .split('\n')
    .filter((l) => !/^\s*allow_implicit_invocation:/.test(l))
    .join('\n')
    .replace(/^policy:\s*\n(?=\S|$)/m, '');
  if (always) return existing;
  const base = stripped.trimEnd();
  if (/^policy:\s*$/m.test(base)) return base.replace(/^policy:\s*$/m, 'policy:\n  allow_implicit_invocation: false') + '\n';
  return (base ? base + '\n' : '') + 'policy:\n  allow_implicit_invocation: false\n';
}

// MARK: The store

type Deps = {
  dataDir: string;
  accounts: () => Account[];
  publish: (n: Notification) => void;
  log: Logger;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  npm?: string;
  version?: string;
};

export class SkillStore {
  private deps: Deps;
  private skills: Skill[] = [];
  private busy: Promise<unknown> = Promise.resolve();

  constructor(deps: Deps) {
    this.deps = deps;
    this.skills = this.readList();
  }

  get root(): string {
    return path.join(this.deps.dataDir, 'skills');
  }

  get pluginDir(): string {
    return path.join(this.root, 'plugin');
  }

  /** The plugins every Claude session gets: the store's, once it has a skill. */
  plugins(): { type: 'local'; path: string }[] {
    return this.skills.length && fs.existsSync(path.join(this.pluginDir, '.claude-plugin', 'plugin.json')) ? [{ type: 'local', path: this.pluginDir }] : [];
  }

  list(): { skills: Skill[]; suggested: SuggestedSkill[] } {
    return { skills: this.skills.map((s) => ({ ...s })), suggested: this.suggested() };
  }

  suggested(): SuggestedSkill[] {
    const have = new Set(this.skills.map((s) => s.name));
    const builtin = this.builtinNames()
      .filter((n) => !have.has(n))
      .map((n) => {
        const fm = readFrontmatter(fs.readFileSync(path.join(BUILTIN_DIR, n, 'SKILL.md'), 'utf8'));
        return { id: n, name: n, description: fm.description ?? '' };
      });
    return [...builtin, ...SUGGESTED.filter((s) => !have.has(s.name)).map((s) => ({ ...s }))];
  }

  /** Puts the plugin and the Codex links back as the list says (at start, and when logins change). */
  sync(): void {
    try {
      this.writePlugin();
      this.linkCodex();
    } catch (err) {
      this.deps.log.warn('skills: sync failed', { err: String(err) });
    }
  }

  add(p: { url?: string; suggested?: string }): Promise<{ skills: Skill[]; added: string[] }> {
    return this.serial(async () => {
      let added: Skill[];
      if (p.suggested) {
        if (this.builtinNames().includes(p.suggested)) added = [await this.addBuiltin(p.suggested)];
        else {
          const known = SUGGESTED.find((s) => s.id === p.suggested);
          if (!known) throw bad(`no suggested skill ${p.suggested}`);
          added = await this.addFromLink(known.url);
        }
      } else if (p.url) {
        added = await this.addFromLink(p.url);
      } else {
        throw bad('give a url or a suggested skill');
      }
      this.changed();
      return { skills: this.list().skills, added: added.map((s) => s.name) };
    });
  }

  update(p: { name: string; always?: boolean; latest?: boolean }): Promise<{ skills: Skill[] }> {
    return this.serial(async () => {
      const skill = this.skills.find((s) => s.name === p.name);
      if (!skill) throw bad(`no skill ${p.name}`);
      if (typeof p.always === 'boolean') skill.always = p.always;
      if (p.latest) {
        if (skill.source.kind === 'builtin') {
          const fresh = await this.addBuiltin(skill.name, true);
          Object.assign(skill, { commit: fresh.commit, dir: fresh.dir, description: fresh.description });
        } else {
          const src = skill.source;
          const fetched = await this.fetchSkills({ repo: src.repo, ref: src.ref, path: src.path }, src.url, skill.name);
          const same = fetched.find((f) => f.name === skill.name);
          if (!same) throw bad(`${skill.name} isn't at ${src.url} any more`);
          Object.assign(skill, { commit: same.commit, dir: same.dir, description: same.description });
        }
      }
      this.changed();
      return { skills: this.list().skills };
    });
  }

  remove(p: { name: string }): Promise<{ skills: Skill[] }> {
    return this.serial(async () => {
      const before = this.skills.length;
      this.skills = this.skills.filter((s) => s.name !== p.name);
      if (this.skills.length === before) throw bad(`no skill ${p.name}`);
      this.changed();
      return { skills: this.list().skills };
    });
  }

  // MARK: Adding

  private async addFromLink(input: string): Promise<Skill[]> {
    let target = parseGitHubLink(input);
    let url = input.trim();
    if (!target) {
      if (!/^https?:\/\//.test(url)) throw bad("that isn't a link: paste a GitHub link to a skill, or a page that has one");
      const res = await this.get(url);
      target = findSkillInPage(await res.text());
      if (!target) throw bad("that page doesn't name a skill on GitHub: paste the skill's GitHub link instead");
      url = `https://github.com/${target.repo}${target.ref ? `/tree/${target.ref}${target.path ? `/${target.path}` : ''}` : ''}`;
    }
    const fetched = await this.fetchSkills(target, url);
    for (const f of fetched) {
      if (this.skills.some((s) => s.name === f.name)) throw bad(`there's already a skill called ${f.name}: remove it first`);
    }
    this.skills.push(...fetched);
    return fetched;
  }

  /** Fetches the target at a pinned commit and copies each skill in it into the store. */
  private async fetchSkills(target: GitHubTarget, url: string, only?: string): Promise<Skill[]> {
    const commitRes = await this.get(`https://api.github.com/repos/${target.repo}/commits/${encodeURIComponent(target.ref ?? 'HEAD')}`, { Accept: 'application/vnd.github.sha' });
    const commit = (await commitRes.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw bad(`couldn't find ${target.ref ?? 'the default branch'} of ${target.repo}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-'));
    try {
      const tarball = await this.get(`https://codeload.github.com/${target.repo}/tar.gz/${commit}`);
      const archive = path.join(tmp, 'src.tar.gz');
      fs.writeFileSync(archive, Buffer.from(await tarball.arrayBuffer()));
      const unpacked = path.join(tmp, 'src');
      fs.mkdirSync(unpacked);
      // tar from PATH: /usr/bin on a Mac, /bin or /usr/bin on Linux (system-tools.ts).
      await run('tar', ['-xzf', archive, '-C', unpacked, '--strip-components', '1']);
      const base = path.resolve(unpacked, target.path ?? '.');
      if (!base.startsWith(unpacked) || !fs.existsSync(base)) throw bad(`${target.path} isn't in ${target.repo}`);
      const found = findSkillDirs(base);
      if (!found.length) throw bad(`there's no SKILL.md in ${url}`);
      const out: Skill[] = [];
      for (const dir of found) {
        const fm = readFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
        const name = (fm.name ?? path.basename(dir)).toLowerCase();
        if (!NAME.test(name)) throw bad(`the skill in ${path.relative(unpacked, dir) || target.repo} has a name Threadbear can't use: ${name}`);
        if (only && name !== only) continue;
        const dest = path.join(this.root, `${name}@${commit.slice(0, 7)}`);
        if (!fs.existsSync(dest)) copyTree(dir, dest);
        const rel = path.relative(unpacked, dir).split(path.sep).join('/');
        out.push({
          name,
          description: fm.description ?? '',
          always: true,
          source: { kind: 'github', repo: target.repo, ...(target.ref ? { ref: target.ref } : {}), ...(rel ? { path: rel } : {}), url },
          commit,
          dir: dest,
          addedAt: new Date().toISOString(),
        });
      }
      return out;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private builtinNames(): string[] {
    try {
      return fs.readdirSync(BUILTIN_DIR).filter((n) => fs.existsSync(path.join(BUILTIN_DIR, n, 'SKILL.md')));
    } catch {
      return [];
    }
  }

  private async addBuiltin(name: string, replace = false): Promise<Skill> {
    if (!replace && this.skills.some((s) => s.name === name)) throw bad(`there's already a skill called ${name}`);
    const src = path.join(BUILTIN_DIR, name);
    const commit = `builtin-${this.deps.version ?? 'dev'}`;
    const dest = path.join(this.root, `${name}@${commit.replace(/[^\w.-]/g, '_')}`);
    if (!fs.existsSync(dest)) {
      const staging = `${dest}.tmp-${process.pid}`;
      fs.rmSync(staging, { recursive: true, force: true });
      copyTree(src, staging);
      if (fs.existsSync(path.join(staging, 'package-lock.json'))) {
        await run(this.deps.npm ?? npmBeside(process.execPath), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging);
      }
      fs.renameSync(staging, dest);
    }
    const fm = readFrontmatter(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'));
    const skill: Skill = { name, description: fm.description ?? '', always: true, source: { kind: 'builtin' }, commit, dir: dest, addedAt: new Date().toISOString() };
    if (!replace) this.skills.push(skill);
    return skill;
  }

  // MARK: Writing it out

  private changed(): void {
    this.writeList();
    this.writePlugin();
    this.linkCodex();
    this.pruneOld();
    this.deps.publish({ method: 'skills.updated', params: { skills: this.list().skills } } as Notification);
  }

  private readList(): Skill[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.root, 'skills.json'), 'utf8'));
      return Array.isArray(parsed.skills) ? parsed.skills.filter((s: Skill) => s && NAME.test(s.name) && fs.existsSync(path.join(s.dir, 'SKILL.md'))) : [];
    } catch {
      return [];
    }
  }

  private writeList(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, 'skills.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ skills: this.skills }, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  }

  /** plugin/: one folder per skill, its SKILL.md adjusted and every other entry a link into the store. */
  private writePlugin(): void {
    const plugin = this.pluginDir;
    const staging = `${plugin}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(staging, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'threadbear', version: '1.0.0', description: "Skills from Threadbear's skills directory" }, null, 2) + '\n',
    );
    for (const skill of this.skills) {
      const view = path.join(staging, 'skills', skill.name);
      fs.mkdirSync(view, { recursive: true });
      for (const entry of fs.readdirSync(skill.dir)) {
        if (entry === 'SKILL.md' || (entry === 'agents' && !skill.always)) continue;
        fs.symlinkSync(path.join(skill.dir, entry), path.join(view, entry));
      }
      fs.writeFileSync(path.join(view, 'SKILL.md'), pluginSkillText(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'), skill.always));
      if (!skill.always) {
        // Codex's switch is agents/openai.yaml; the skill's own other agent files stay linked.
        const own = path.join(skill.dir, 'agents');
        fs.mkdirSync(path.join(view, 'agents'));
        if (fs.existsSync(own)) for (const f of fs.readdirSync(own)) if (f !== 'openai.yaml') fs.symlinkSync(path.join(own, f), path.join(view, 'agents', f));
        const yaml = fs.existsSync(path.join(own, 'openai.yaml')) ? fs.readFileSync(path.join(own, 'openai.yaml'), 'utf8') : null;
        fs.writeFileSync(path.join(view, 'agents', 'openai.yaml'), codexPolicy(yaml, false) ?? '');
      }
    }
    fs.rmSync(plugin, { recursive: true, force: true });
    fs.renameSync(staging, plugin);
  }

  /** Each Codex login's $CODEX_HOME/skills/<name>, a link to the plugin's folder; only links of ours are touched. */
  private linkCodex(): void {
    const want = new Set(this.skills.map((s) => s.name));
    const mine = (target: string) => path.resolve(target).startsWith(path.resolve(this.pluginDir) + path.sep);
    for (const account of this.deps.accounts().filter((a) => a.provider === 'codex')) {
      const dir = path.join(account.configDir, 'skills');
      try {
        fs.mkdirSync(dir, { recursive: true });
        for (const entry of fs.readdirSync(dir)) {
          const at = path.join(dir, entry);
          const stat = fs.lstatSync(at);
          if (stat.isSymbolicLink() && mine(fs.readlinkSync(at)) && !want.has(entry)) fs.unlinkSync(at);
        }
        for (const name of want) {
          const at = path.join(dir, name);
          const target = path.join(this.pluginDir, 'skills', name);
          let stat: fs.Stats | undefined;
          try {
            stat = fs.lstatSync(at);
          } catch {
            stat = undefined;
          }
          if (!stat) fs.symlinkSync(target, at);
          else if (!stat.isSymbolicLink() || !mine(fs.readlinkSync(at))) this.deps.log.info('skills: left a skill of the same name alone', { account: account.id, name });
          else if (fs.readlinkSync(at) !== target) {
            fs.unlinkSync(at);
            fs.symlinkSync(target, at);
          }
        }
      } catch (err) {
        this.deps.log.warn('skills: could not link into a Codex login', { account: account.id, err: String(err) });
      }
    }
  }

  /** Store folders nothing points at any more. */
  private pruneOld(): void {
    const keep = new Set(this.skills.map((s) => path.basename(s.dir)));
    for (const entry of fs.readdirSync(this.root)) {
      if (!entry.includes('@') || keep.has(entry)) continue;
      fs.rmSync(path.join(this.root, entry), { recursive: true, force: true });
    }
  }

  // MARK: Helpers

  private async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await (this.deps.fetch ?? fetch)(url, { headers: { 'User-Agent': 'threadbear-runner', ...headers }, redirect: 'follow' });
    if (!res.ok) throw bad(res.status === 404 ? `${url} wasn't found (a private repo can't be imported)` : `${url} answered ${res.status}`);
    return res;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }
}

/** The folders under `base` with a SKILL.md: `base` itself, or up to three levels down. */
export function findSkillDirs(base: string): string[] {
  if (fs.existsSync(path.join(base, 'SKILL.md'))) return [base];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
      const sub = path.join(dir, entry.name);
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) out.push(sub);
      else walk(sub, depth + 1);
    }
  };
  walk(base, 1);
  return out.sort();
}

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, filter: (src) => !/(^|[/\\])\.git([/\\]|$)/.test(src) && !/(^|[/\\])node_modules([/\\]|$)/.test(path.relative(from, src)) });
}

function npmBeside(node: string): string {
  const npm = path.join(path.dirname(node), 'npm');
  return fs.existsSync(npm) ? npm : 'npm';
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0]} failed: ${err.trim().slice(-300)}`))));
  });
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

export function skillMethods(s: SkillStore): Record<string, (p: Record<string, unknown>) => unknown> {
  const name = (p: Record<string, unknown>) => {
    if (typeof p.name !== 'string' || !p.name) throw bad('name is required');
    return p.name;
  };
  return {
    'skills.list': () => s.list(),
    'skills.add': (p) =>
      s.add({ url: typeof p.url === 'string' ? p.url : undefined, suggested: typeof p.suggested === 'string' ? p.suggested : undefined }),
    'skills.update': (p) => {
      if (p.always !== undefined && typeof p.always !== 'boolean') throw bad('always must be a boolean');
      return s.update({ name: name(p), always: p.always as boolean | undefined, latest: p.latest === true });
    },
    'skills.remove': (p) => s.remove({ name: name(p) }),
  };
}
