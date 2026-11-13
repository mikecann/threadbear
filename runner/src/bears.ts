// Bears (experiment `bears`, docs/protocol.md "Bears"): named teammates the
// bear's way. A bear is a folder, `<threads dir>/Bears/<id>/`, whose
// CLAUDE.md is its persona and memory rules, so a thread there is the bear.
// The id is fixed when it's made and never changes; the name lives in
// bear.json, so a rename touches one field and every routine, webhook,
// mention and old thread still finds it.
//
// What a bear may change about itself sits in its folder (bear.json: name,
// face, does, model, effort, quiet hours, notes). What widens its reach
// (permissionMode, poolId, runner) and the user's own arrangement of the list
// (pin, order, away, archived, projects) sit in the runner's data dir,
// bears.json, which the bear's own agent can't reach on its own say-so
// (Agentbox's rule: an agent can't promote its own work).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderAvatarSvg, validateAvatar, type AvatarDefinition } from 'open-bot-avatar';
import { ErrorCode, isEffortLevel, isPermissionMode, RpcError, type EffortLevel, type PermissionMode, type Schedule } from './protocol.ts';
import { expandHome } from './config.ts';
import { raises } from './threadbear-mcp.ts';

export const EXPERIMENT = 'bears';
export const NAME_MAX = 40;
const DOES_MAX = 200;
const PERSONALITY_MAX = 200;
export const DEFAULT_QUIET = '19:30-08:30';
// The daily memory tidy, at a quiet hour.
const TIDY_CRON = '30 4 * * *';
export const NOTE_KINDS = ['off', 'cheers', 'ideas', 'both'] as const;
export type BearNotes = (typeof NOTE_KINDS)[number];
export const AVATAR_DIR = path.join(import.meta.dirname, '..', 'skills', 'bears', 'avatars');

// bear.json, in the bear's folder: harmless fields only.
export type BearFile = {
  name: string;
  icon?: string; // an SF Symbol, when there's no face
  does?: string;
  personality?: string;
  model?: string;
  effort?: EffortLevel;
  avatar?: AvatarDefinition;
  color?: string;
  quietHours?: string; // "HH:MM-HH:MM", local time
  notes?: BearNotes; // bear notes (experiment bearNotes)
};

// bears.json in the data dir, per bear id.
export type BearState = {
  permissionMode?: PermissionMode;
  poolId?: string;
  runner?: string;
  pinned?: number; // pin order: lower first
  order?: number; // manual order
  awayUntil?: string; // ISO time: hibernating till then
  archivedAt?: string;
  projects?: string[];
};

export type BearFaces = { idle: string; thinking: string; happy: string };

export type BearInfo = BearFile & {
  id: string;
  folder: string;
  state: BearState;
  // The chief of staff: the one bear that runs the others.
  head: boolean;
  away: boolean;
  archived: boolean;
  routines: { id: string; title: string; whenText: string; nextRunAt?: string; paused: boolean }[];
  faces?: BearFaces;
};

export type BearSchedules = {
  list(): Schedule[];
  create(p: { text: string; title?: string; cron?: string; at?: string; cwd?: string; permissionMode?: PermissionMode; createdBy?: string }): Promise<Schedule>;
  update(p: { scheduleId: string; paused?: boolean }): Promise<Schedule>;
  delete(scheduleId: string): Promise<unknown>;
};

export type BearThreads = {
  // Threads this runner has, for archiving a deleted bear's.
  list(): { id: string; cwd: string; archivedAt?: string }[];
  archive(threadId: string): void;
};

export type BearsDeps = {
  root: string; // the Bears folder
  home: string; // the runner's data dir
  now?: () => number;
  schedules?: () => BearSchedules | undefined;
  threads?: () => BearThreads | undefined;
  // git init a new bear's folder; tests turn it off.
  git?: boolean;
};

const fail = (message: string, code: number = ErrorCode.badParams) => new RpcError(code, message);

// Where bears live: next to the runner's default folder (~/ThreadbearThreads
// on a new install, ThreadbearThreads/<Profile> on a profile's runner), as
// the bear's own Bear folder is. A default of the home folder itself puts
// them in ~/ThreadbearThreads, never straight in ~.
export function bearsRoot(defaultCwd: string): string {
  const base = path.resolve(expandHome(defaultCwd || '~'));
  return base === path.resolve(os.homedir()) ? path.join(os.homedir(), 'ThreadbearThreads', 'Bears') : path.join(base, 'Bears');
}

// "researcher-7f3a": the name, made safe, and four random hex.
export function newBearId(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'bear';
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function cleanName(v: unknown): string {
  if (typeof v !== 'string') throw fail('name is required');
  const name = v.replace(/[\u0000-\u001f\u007f@\[\]]/g, '').trim().slice(0, NAME_MAX);
  if (!name) throw fail('name is required');
  return name;
}

function cleanLine(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw fail(`${what} must be text`);
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || undefined;
}

export function parseQuiet(v: string): { from: number; to: number } | undefined {
  const m = v.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined;
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

// A time inside the quiet hours moves to the end of them (local time), so
// a follow-up a bear books never lands at night (Instinct's rule).
export function shiftOutOfQuiet(at: number, quietHours = DEFAULT_QUIET): number {
  const q = parseQuiet(quietHours);
  if (!q || q.from === q.to) return at;
  const d = new Date(at);
  const mins = d.getHours() * 60 + d.getMinutes();
  const inside = q.from < q.to ? mins >= q.from && mins < q.to : mins >= q.from || mins < q.to;
  if (!inside) return at;
  const end = new Date(at);
  end.setHours(Math.floor(q.to / 60), q.to % 60, 0, 0);
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);
  return end.getTime();
}

export function checkAvatar(v: unknown): AvatarDefinition {
  const r = validateAvatar(v);
  if (!r.ok) throw fail(`That face isn't a valid Open Bot Avatar: ${r.errors.slice(0, 3).join('; ')}`);
  return r.value;
}

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The bear-shaped faces that ship with the skill.
export function avatarPresets(dir = AVATAR_DIR): { id: string; color: string; avatar: AvatarDefinition }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { color?: string; avatar?: unknown };
      return [{ id: f.replace(/\.json$/, ''), color: typeof j.color === 'string' && COLOR_RE.test(j.color) ? j.color : '#D69454', avatar: checkAvatar(j.avatar) }];
    } catch {
      return [];
    }
  });
}

// SVG stills for the three moods, cached by the face and colour.
const faceCache = new Map<string, BearFaces>();
export function renderFaces(avatar: AvatarDefinition, color = '#D69454'): BearFaces {
  const key = crypto.createHash('sha256').update(JSON.stringify([avatar, color])).digest('hex');
  const hit = faceCache.get(key);
  if (hit) return hit;
  const one = (motion: 'idle' | 'thinking' | 'happy') => renderAvatarSvg(avatar, { color, motion, reducedMotion: true, time: 0 });
  const faces = { idle: one('idle'), thinking: one('thinking'), happy: one('happy') };
  if (faceCache.size > 200) faceCache.clear();
  faceCache.set(key, faces);
  return faces;
}

// Checks the fields of a bear.json (from a file or an RPC), keeping only
// the ones it knows.
export function checkBearFile(j: Record<string, unknown>): BearFile {
  const out: BearFile = { name: cleanName(j.name) };
  const icon = cleanLine(j.icon, 60, 'icon');
  if (icon) out.icon = icon;
  const does = cleanLine(j.does, DOES_MAX, 'does');
  if (does) out.does = does;
  const personality = cleanLine(j.personality, PERSONALITY_MAX, 'personality');
  if (personality) out.personality = personality;
  const model = cleanLine(j.model, 80, 'model');
  if (model) out.model = model;
  if (j.effort !== undefined && j.effort !== null && j.effort !== '') {
    if (!isEffortLevel(j.effort)) throw fail('effort is not an effort level');
    out.effort = j.effort;
  }
  if (j.avatar !== undefined && j.avatar !== null) out.avatar = checkAvatar(j.avatar);
  if (j.color !== undefined && j.color !== null && j.color !== '') {
    if (typeof j.color !== 'string' || !COLOR_RE.test(j.color)) throw fail('color is #rgb or #rrggbb');
    out.color = j.color;
  }
  if (j.quietHours !== undefined && j.quietHours !== null && j.quietHours !== '') {
    if (typeof j.quietHours !== 'string' || !parseQuiet(j.quietHours)) throw fail('quietHours is like "19:30-08:30"');
    out.quietHours = j.quietHours;
  }
  if (j.notes !== undefined && j.notes !== null) {
    if (!(NOTE_KINDS as readonly unknown[]).includes(j.notes)) throw fail(`notes is one of ${NOTE_KINDS.join(', ')}`);
    out.notes = j.notes as BearNotes;
  }
  return out;
}

// The persona: CLAUDE.md, and the same as AGENTS.md for Codex. Written only
// when missing, so after that it's the user's to change.
export function bearInstructions(b: { name: string; does?: string; personality?: string }): string {
  return `# ${b.name}

You are ${b.name}, one of the user's bears in Threadbear: a named teammate with
your own folder and memory.${b.does ? ` What you do: ${b.does}` : ''}

## Personality

${b.personality || 'Calm, warm and to the point.'} Let it colour your words, never pad them.

## Memory

@../memory/summary.md
@memory/summary.md

- Read the two summaries above at the start of a chat (Codex: read
  ../memory/summary.md and memory/summary.md first).
- Facts about the user (who they are, their preferences, their people) go in
  the shared memory, ../memory/. Anything about your own job goes in your
  own, memory/ (people/, facts/, projects/), linked with [[name]].
- Decisions about the work go in the project's notes, where every thread in
  the project sees them. Never keep the same fact in two places.
- Keep memory/summary.md to one page: what matters most, now.
- "Forget this" means delete it, from every file it's in. Never save
  passwords, keys or codes.
- Never edit another bear's folder or memory.

## Style

- Short replies, plain words, one idea per paragraph.
- No markdown filler. A link goes on its own line.
- Anything that will take more than a couple of minutes goes to a background
  sub-agent, so you can still answer a quick question.

## Before you act

- Anything that sends, buys, books or speaks for the user goes out as a draft
  first (a \`\`\`draft, \`\`\`email or \`\`\`slack block, or a Needs you card).
- Secrets only ever come through ask_secret.

## Be straight

- Say what you couldn't check. Never say something was sent or worked
  without seeing proof.
- Pin a screenshot or the output of what you built.

## Routines and follow-ups

- A routine, webhook or mention run starts by reading the project's state
  and your last thread for that job, and says in one line where it's
  picking up from.
- When the user leaves something half done, book one follow-up with
  schedule_message about a day later. Never at night: the runner moves
  anything you book out of your quiet hours.
`;
}

const TIDY_TEXT = `Tidy your memory. Merge duplicates in memory/, refresh memory/summary.md so it stays one page, and delete anything the user said not to keep. If you own the shared memory (../memory/), tidy that too. Commit the changes with git in this folder. Keep it short and say what changed in one line.`;

export class Bears {
  readonly root: string;
  private readonly stateFile: string;
  private readonly d: BearsDeps;

  constructor(d: BearsDeps) {
    this.d = d;
    this.root = path.resolve(d.root);
    this.stateFile = path.join(d.home, 'runner', 'bears.json');
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ------------------------------------------------------------ state

  readState(): { bears: Record<string, BearState>; head?: string; seeded?: boolean; tables?: Record<string, { pinned?: number; order?: number }> } {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { bears?: unknown; tables?: unknown; head?: unknown; seeded?: unknown };
      const bears = j.bears && typeof j.bears === 'object' && !Array.isArray(j.bears) ? (j.bears as Record<string, BearState>) : {};
      const tables = j.tables && typeof j.tables === 'object' && !Array.isArray(j.tables) ? (j.tables as Record<string, { pinned?: number; order?: number }>) : undefined;
      return { bears, ...(typeof j.head === 'string' ? { head: j.head } : {}), ...(j.seeded === true ? { seeded: true } : {}), ...(tables ? { tables } : {}) };
    } catch {
      return { bears: {} };
    }
  }

  private writeState(s: ReturnType<Bears['readState']>): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  private changeState(id: string, fn: (s: BearState) => void): BearState {
    const all = this.readState();
    const s = { ...(all.bears[id] ?? {}) };
    fn(s);
    for (const k of Object.keys(s) as (keyof BearState)[]) if (s[k] === undefined) delete s[k];
    all.bears[id] = s;
    this.writeState(all);
    return s;
  }

  // ------------------------------------------------------------ reading

  folderOf(id: string): string {
    if (!ID_RE.test(id)) throw fail(`No bear called ${id}`, ErrorCode.other);
    return path.join(this.root, id);
  }

  private readFile(id: string): BearFile | undefined {
    try {
      return checkBearFile(JSON.parse(fs.readFileSync(path.join(this.root, id, 'bear.json'), 'utf8')) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  private info(id: string, file: BearFile, state: BearState, schedules: Schedule[], faces: boolean, head = this.readState().head): BearInfo {
    const folder = path.join(this.root, id);
    const routines = schedules
      .filter((s) => !s.threadId && s.cwd && path.resolve(expandHome(s.cwd)) === folder)
      .map((s) => ({ id: s.id, title: s.title, whenText: s.whenText, ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}), paused: s.paused }));
    const away = Boolean(state.awayUntil && Date.parse(state.awayUntil) > this.now());
    const out: BearInfo = { ...file, id, folder, state, head: head === id, away, archived: Boolean(state.archivedAt), routines };
    if (faces && file.avatar) {
      try {
        out.faces = renderFaces(file.avatar, file.color);
      } catch {
        /* a face that won't draw falls back to the icon */
      }
    }
    return out;
  }

  // Every bear with a readable bear.json, pinned first (in pin order), then
  // in the user's order, then by name. Archived ones only when asked.
  list(o: { archived?: boolean; faces?: boolean } = {}): BearInfo[] {
    if (!fs.existsSync(this.root)) return [];
    const all = this.readState();
    const state = all.bears;
    const schedules = this.schedulesList();
    const out: BearInfo[] = [];
    for (const id of fs.readdirSync(this.root)) {
      if (!ID_RE.test(id) || id === 'memory') continue;
      const file = this.readFile(id);
      if (!file) continue;
      const b = this.info(id, file, state[id] ?? {}, schedules, o.faces !== false, all.head);
      if (b.archived && !o.archived) continue;
      out.push(b);
    }
    const big = Number.MAX_SAFE_INTEGER;
    return out.sort(
      (a, b) =>
        Number(b.head) - Number(a.head) ||
        (a.state.pinned ?? big) - (b.state.pinned ?? big) ||
        (a.state.order ?? big) - (b.state.order ?? big) ||
        a.name.localeCompare(b.name),
    );
  }

  private schedulesList(): Schedule[] {
    try {
      return this.d.schedules?.()?.list() ?? [];
    } catch {
      return [];
    }
  }

  // By id, or by name (any case). Archived ones too.
  get(idOrName: string, o: { faces?: boolean } = {}): BearInfo {
    const key = idOrName.trim().replace(/^@/, '').replace(/^bear:/, '');
    const all = this.list({ archived: true, faces: o.faces });
    const hit = all.find((b) => b.id === key) ?? all.find((b) => b.name.toLowerCase() === key.toLowerCase());
    if (!hit) throw fail(`No bear called ${idOrName}`, ErrorCode.other);
    return hit;
  }

  // The bear whose folder this is, or that it's inside.
  forCwd(cwd: string): BearInfo | undefined {
    const dir = path.resolve(expandHome(cwd));
    const rel = path.relative(this.root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const id = rel.split(path.sep)[0];
    if (!ID_RE.test(id) || id === 'memory') return undefined;
    const file = this.readFile(id);
    return file ? this.info(id, file, this.readState().bears[id] ?? {}, [], false) : undefined;
  }

  // What a thread in a bear's folder shows in the sidebar: the bear's
  // name, icon and colour (ThreadSummary.bear).
  tile(cwd: string): { id: string; name: string; icon?: string; color?: string; head?: boolean } | undefined {
    const b = this.forCwd(cwd);
    if (!b) return undefined;
    return { id: b.id, name: b.name, ...(b.icon ? { icon: b.icon } : {}), ...(b.color ? { color: b.color } : {}), ...(b.head ? { head: true } : {}) };
  }

  // What a new thread in a bear's folder starts with, where the caller
  // didn't say (Runner.makeThread). Unattended runs (a routine, a webhook,
  // a mention) start in Ask unless the user raised the bear themselves.
  newThreadDefaults(cwd: string, unattended: boolean): { model?: string; effort?: EffortLevel; poolId?: string; permissionMode?: PermissionMode; projectIds?: string[] } | undefined {
    const b = this.forCwd(cwd);
    if (!b) return undefined;
    const mode = b.state.permissionMode ?? (unattended ? 'ask' : undefined);
    return {
      ...(b.model ? { model: b.model } : {}),
      ...(b.effort ? { effort: b.effort } : {}),
      ...(b.state.poolId ? { poolId: b.state.poolId } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      ...(b.state.projects?.length ? { projectIds: b.state.projects } : {}),
    };
  }

  // Why nothing should start for this folder's bear right now, if so:
  // away (hibernating) or archived. A routine's run is skipped with it.
  holdReason(cwd: string): string | undefined {
    const b = this.forCwd(cwd);
    if (!b) return undefined;
    if (b.archived) return `${b.name} is archived.`;
    if (b.away) return `${b.name} is away until ${awayText(b.state.awayUntil!)}.`;
    return undefined;
  }

  // ------------------------------------------------------------ making

  async create(p: { name: unknown; does?: unknown; personality?: unknown; icon?: unknown; model?: unknown; effort?: unknown; avatar?: unknown; preset?: unknown; color?: unknown; quietHours?: unknown; tidy?: boolean; createdBy?: string }): Promise<BearInfo> {
    let avatar = p.avatar;
    let color = p.color;
    if (avatar === undefined && typeof p.preset === 'string') {
      const preset = avatarPresets().find((x) => x.id === p.preset);
      if (!preset) throw fail(`No face called ${p.preset}. Faces: ${avatarPresets().map((x) => x.id).join(', ')}`);
      avatar = { ...preset.avatar };
      color ??= preset.color;
    }
    const file = checkBearFile({ name: p.name, does: p.does, personality: p.personality, icon: p.icon ?? 'pawprint', model: p.model, effort: p.effort, avatar, color, quietHours: p.quietHours ?? DEFAULT_QUIET });
    if (this.list({ archived: true, faces: false }).some((b) => b.name.toLowerCase() === file.name.toLowerCase())) throw fail(`There's already a bear called ${file.name}.`);
    const id = newBearId(file.name);
    const folder = path.join(this.root, id);
    fs.mkdirSync(path.join(folder, 'memory'), { recursive: true });
    for (const sub of ['people', 'facts', 'projects']) {
      fs.mkdirSync(path.join(folder, 'memory', sub), { recursive: true });
      writeIfMissing(path.join(folder, 'memory', sub, '.gitkeep'), '');
    }
    writeIfMissing(path.join(folder, 'memory', 'summary.md'), `# ${file.name}'s memory\n\nNothing yet.\n`);
    // The memory every bear shares: lasting facts about the user.
    fs.mkdirSync(path.join(this.root, 'memory'), { recursive: true });
    writeIfMissing(path.join(this.root, 'memory', 'summary.md'), '# What every bear knows about the user\n\nNothing yet.\n');
    const text = bearInstructions(file);
    writeIfMissing(path.join(folder, 'CLAUDE.md'), text);
    writeIfMissing(path.join(folder, 'AGENTS.md'), text);
    fs.writeFileSync(path.join(folder, 'bear.json'), `${JSON.stringify(file, null, 2)}\n`);
    if (this.d.git !== false) {
      try {
        execFileSync('git', ['init', '-q'], { cwd: folder, stdio: 'ignore', timeout: 10_000 });
      } catch {
        /* no git: memory still works, just without history */
      }
    }
    if (p.tidy !== false) {
      const s = this.d.schedules?.();
      if (s) {
        try {
          await s.create({ text: TIDY_TEXT, title: `${file.name}: tidy memory`, cron: TIDY_CRON, cwd: folder, permissionMode: 'ask', ...(p.createdBy ? { createdBy: p.createdBy } : {}) });
        } catch {
          /* the bear is made; the routine can be added later */
        }
      }
    }
    return this.get(id);
  }

  // Harmless fields only (bear.json). Anything else is refused.
  update(id: string, fields: Record<string, unknown>): BearInfo {
    const b = this.get(id, { faces: false });
    for (const k of Object.keys(fields)) {
      if (['permissionMode', 'poolId', 'runner'].includes(k)) throw fail(`${k} widens what a bear can do: use bears.setAccess.`);
      if (!['name', 'icon', 'does', 'personality', 'model', 'effort', 'avatar', 'color', 'quietHours', 'notes'].includes(k)) throw fail(`A bear has no field ${k}`);
    }
    const cur = this.readFile(b.id) ?? { name: b.name };
    const next: Record<string, unknown> = { ...cur, ...fields };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    const file = checkBearFile(next);
    if (file.name.toLowerCase() !== cur.name.toLowerCase() && this.list({ archived: true, faces: false }).some((x) => x.id !== b.id && x.name.toLowerCase() === file.name.toLowerCase())) {
      throw fail(`There's already a bear called ${file.name}.`);
    }
    fs.writeFileSync(path.join(b.folder, 'bear.json'), `${JSON.stringify(file, null, 2)}\n`);
    return this.get(b.id);
  }

  // The fields that widen a bear's reach. `callerCwd` is the folder of the
  // thread asking, when one is: a bear's own thread can't raise itself.
  setAccess(id: string, p: { permissionMode?: unknown; poolId?: unknown; runner?: unknown }, callerCwd?: string): BearInfo {
    const b = this.get(id, { faces: false });
    // No bear's thread, the head bear's included, changes what a bear may do.
    const asking = callerCwd !== undefined ? this.forCwd(callerCwd) : undefined;
    if (asking) {
      const who = asking.id === b.id ? `${b.name}'s own thread` : `A bear's thread (${asking.name})`;
      throw fail(`${who} can't change what ${b.name} may do. The user changes that in the app or with tb in a terminal.`, ErrorCode.notAllowed);
    }
    if (p.permissionMode !== undefined && p.permissionMode !== null && !isPermissionMode(p.permissionMode)) throw fail('permissionMode is full, auto, ask or plan');
    for (const k of ['poolId', 'runner'] as const) if (p[k] !== undefined && p[k] !== null && typeof p[k] !== 'string') throw fail(`${k} must be text`);
    this.changeState(b.id, (s) => {
      if (p.permissionMode !== undefined) s.permissionMode = (p.permissionMode ?? undefined) as PermissionMode | undefined;
      if (p.poolId !== undefined) s.poolId = (p.poolId as string | null) || undefined;
      if (p.runner !== undefined) s.runner = (p.runner as string | null) || undefined;
    });
    return this.get(b.id);
  }

  // ------------------------------------------------------------ head

  // Makes one bear the chief of staff (null: none). Its CLAUDE.md gets the
  // marked block that says so, and loses it when it's no longer the head bear.
  setHead(id: string | null): BearInfo[] {
    const all = this.readState();
    const was = all.head;
    const next = id === null ? undefined : this.get(id, { faces: false }).id;
    if (next) all.head = next;
    else delete all.head;
    this.writeState(all);
    if (was && was !== next) setHeadBlock(path.join(this.root, was), false);
    if (next) setHeadBlock(path.join(this.root, next), true);
    return this.list();
  }

  headBear(): BearInfo | undefined {
    const id = this.readState().head;
    return id ? this.list({ faces: false }).find((b) => b.id === id) : undefined;
  }

  // The first time bears are listed with the experiment on and there are
  // none, Head Bear is made, as chief of staff. Once only: deleting it
  // doesn't bring it back.
  async ensureDefault(): Promise<void> {
    const all = this.readState();
    if (all.seeded) return;
    all.seeded = true;
    this.writeState(all);
    if (this.list({ archived: true, faces: false }).length) return;
    const b = await this.create({ ...DEFAULT_BEAR });
    this.setHead(b.id);
  }

  // ------------------------------------------------------------ managing

  pin(id: string, on: boolean): BearInfo {
    const b = this.get(id, { faces: false });
    const top = Math.max(-1, ...Object.values(this.readState().bears).map((s) => s.pinned ?? -1));
    this.changeState(b.id, (s) => {
      s.pinned = on ? (s.pinned ?? top + 1) : undefined;
    });
    return this.get(b.id);
  }

  // Puts a bear at `index` in the manual order (0 first) and renumbers.
  move(id: string, index: number): BearInfo[] {
    if (!Number.isInteger(index) || index < 0) throw fail('index is a whole number from 0');
    const b = this.get(id, { faces: false });
    const ids = this.list({ faces: false }).map((x) => x.id).filter((x) => x !== b.id);
    ids.splice(Math.min(index, ids.length), 0, b.id);
    const all = this.readState();
    ids.forEach((x, i) => {
      all.bears[x] = { ...(all.bears[x] ?? {}), order: i };
    });
    this.writeState(all);
    return this.list();
  }

  // Away till then: its routines' runs are skipped and a mention gets the
  // away line. null wakes it.
  async hibernate(id: string, until: string | null): Promise<BearInfo> {
    const b = this.get(id, { faces: false });
    if (until !== null) {
      const t = Date.parse(until);
      if (!Number.isFinite(t) || t <= this.now()) throw fail('until is a time in the future');
    }
    this.changeState(b.id, (s) => {
      s.awayUntil = until === null ? undefined : new Date(Date.parse(until)).toISOString();
    });
    return this.get(b.id);
  }

  // Off the list, its routines paused (they stay paused on unarchive until
  // The user resumes them). Webhooks are revoked by the caller (main.ts).
  async archive(id: string, on: boolean): Promise<BearInfo> {
    const b = this.get(id, { faces: false });
    this.changeState(b.id, (s) => {
      s.archivedAt = on ? (s.archivedAt ?? new Date(this.now()).toISOString()) : undefined;
    });
    if (on) await this.pauseRoutines(b);
    return this.get(b.id);
  }

  private async pauseRoutines(b: BearInfo): Promise<void> {
    const s = this.d.schedules?.();
    if (!s) return;
    for (const r of b.routines) if (!r.paused) await s.update({ scheduleId: r.id, paused: true }).catch(() => undefined);
  }

  // Projects a bear's new threads join (Projects.changeMembership).
  setProjects(id: string, p: { add?: string[]; remove?: string[] }): BearInfo {
    const b = this.get(id, { faces: false });
    this.changeState(b.id, (s) => {
      const set = new Set(s.projects ?? []);
      for (const x of p.add ?? []) set.add(x);
      for (const x of p.remove ?? []) set.delete(x);
      s.projects = set.size ? [...set] : undefined;
    });
    return this.get(b.id);
  }

  // The folder goes to the runner's trash (as a deleted thread's does), its
  // routines are deleted and its threads archived. Its threads stay.
  async delete(id: string): Promise<{ trashed: string }> {
    const b = this.get(id, { faces: false });
    const s = this.d.schedules?.();
    for (const r of b.routines) {
      await s?.delete(r.id).catch(() => undefined);
    }
    const threads = this.d.threads?.();
    for (const t of threads?.list() ?? []) {
      if (!t.archivedAt && this.forCwd(t.cwd)?.id === b.id) {
        try {
          threads!.archive(t.id);
        } catch {
          /* one that won't archive stays where it is */
        }
      }
    }
    const bin = path.join(this.d.home, 'trash');
    fs.mkdirSync(bin, { recursive: true });
    const to = path.join(bin, `bear-${b.id}-${this.now()}`);
    try {
      fs.renameSync(b.folder, to);
    } catch {
      // Another volume: copy, then remove.
      fs.cpSync(b.folder, to, { recursive: true });
      fs.rmSync(b.folder, { recursive: true, force: true });
    }
    const all = this.readState();
    delete all.bears[b.id];
    if (all.head === b.id) delete all.head;
    this.writeState(all);
    return { trashed: to };
  }
}

export const DEFAULT_BEAR = {
  name: 'Head Bear',
  does: 'Chief of staff: keeps the other bears on track and hands them work.',
  personality: 'Warm, organised and a little bossy, in a kind way.',
  preset: 'round',
};

const HEAD_START = '<!-- head-bear: start -->';
const HEAD_END = '<!-- head-bear: end -->';
export const HEAD_TEXT = `${HEAD_START}
## Chief of staff

You're Head Bear: you run the user's other bears.

- \`tb bears list\` shows them, with what each does and whether it's away.
- Hand a job to a bear with \`tb bears ask <bear> "<what>"\`. Its reply
  comes back into this thread. Ask one bear at a time unless the jobs are
  separate.
- Make, rename, pin, pause or wake bears with \`tb bears\` (the bears skill
  has the commands). You can't change what a bear may do (its mode, pool or
  machine), and you never delete one: the user does those.
- Keep a short roster in memory/facts/bears.md: who does what, and what each
  is busy with.
${HEAD_END}
`;

function setHeadBlock(folder: string, on: boolean): void {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(folder, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf(HEAD_START);
    const end = text.indexOf(HEAD_END);
    const without = start >= 0 && end > start ? text.slice(0, start).trimEnd() + '\n' + text.slice(end + HEAD_END.length).replace(/^\n+/, '\n') : text;
    const next = on ? `${without.trimEnd()}\n\n${HEAD_TEXT}` : without;
    if (next !== text) fs.writeFileSync(file, next);
  }
}

function writeIfMissing(file: string, text: string): void {
  if (!fs.existsSync(file)) fs.writeFileSync(file, text);
}

export function awayText(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// The lower of two modes, for a mention or a table reply: access never widens.
export function lowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return raises(a, b) ? b : a;
}

// ------------------------------------------------------------------ RPC

export type BearsMethodsDeps = {
  bears: Bears;
  on: () => boolean;
  // The folder of the thread calling, when one is (rpc-gate.ts puts its id
  // in `_caller`).
  cwdOf: (threadId: string) => string | undefined;
  // Revokes a bear's webhooks when it's archived or deleted (webhooks.ts).
  revokeHooks?: (bearFolder: string) => Promise<unknown>;
  // Hands a question to a bear (mentions.ts).
  mention?: (p: { fromThreadId?: string; bear: string; text: string }) => unknown;
  // Takes a bear out of its tables when it's archived (tables.ts).
  unseat?: (bearId: string) => unknown;
  // Sends the threads in bears' folders again, so their sidebar tiles
  // follow a new name, icon, colour or head bear.
  touch?: () => void;
};

const OFF = 'Bears are off: turn them on in Settings > General > Experiments.';

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  if (typeof v !== 'string' || !v.trim()) throw fail(`${k} is required`);
  return v.trim();
}

// bears.* (docs/protocol.md, "Bears"). The app, tb and threads all reach a
// bear through these, so any UI does it the same way.
export function bearsMethods(d: BearsMethodsDeps): Record<string, (p: Record<string, unknown>) => unknown> {
  const on = () => {
    if (!d.on()) throw fail(OFF, ErrorCode.other);
  };
  const callerCwd = (p: Record<string, unknown>) => (typeof p._caller === 'string' ? (d.cwdOf(p._caller) ?? '') : undefined);
  return {
    'bears.list': async (p) => {
      if (!d.on()) return { on: false, bears: [] };
      await d.bears.ensureDefault();
      return { on: true, root: d.bears.root, bears: d.bears.list({ archived: p.archived === true, faces: p.faces !== false }) };
    },
    // Only the user picks the chief of staff: never from a bear's own thread.
    'bears.setHead': (p) => {
      on();
      const cwd = callerCwd(p);
      if (cwd !== undefined && d.bears.forCwd(cwd)) throw fail("A bear's thread can't pick the chief of staff. The user does that in the app or with tb in a terminal.", ErrorCode.notAllowed);
      const bears = d.bears.setHead(p.bear === null || p.bear === '' || p.bear === undefined ? null : str(p, 'bear'));
      d.touch?.();
      return { bears };
    },
    'bears.get': (p) => (on(), { bear: d.bears.get(str(p, 'bear')) }),
    'bears.faces': () => (on(), { faces: avatarPresets().map((x) => ({ ...x, faces: renderFaces(x.avatar, x.color) })) }),
    'bears.create': async (p) => {
      on();
      const createdBy = typeof p._caller === 'string' ? p._caller : undefined;
      return { bear: await d.bears.create({ ...p, name: p.name, tidy: p.tidy !== false, ...(createdBy ? { createdBy } : {}) }) };
    },
    'bears.update': (p) => {
      on();
      const { bear, _caller, ...fields } = p;
      void _caller;
      const updated = d.bears.update(str({ bear }, 'bear'), fields);
      d.touch?.();
      return { bear: updated };
    },
    'bears.setAccess': (p) => (on(), { bear: d.bears.setAccess(str(p, 'bear'), p, callerCwd(p)) }),
    'bears.pin': (p) => (on(), { bear: d.bears.pin(str(p, 'bear'), p.pinned !== false) }),
    'bears.move': (p) => (on(), { bears: d.bears.move(str(p, 'bear'), Number(p.index)) }),
    'bears.hibernate': async (p) => {
      on();
      const until = p.until === null || p.until === undefined || p.until === '' ? null : String(p.until);
      return { bear: await d.bears.hibernate(str(p, 'bear'), until) };
    },
    'bears.archive': async (p) => {
      on();
      const archived = p.archived !== false;
      const bear = await d.bears.archive(str(p, 'bear'), archived);
      if (archived) {
        await d.revokeHooks?.(bear.folder).catch(() => undefined);
        d.unseat?.(bear.id);
      }
      return { bear };
    },
    'bears.setProjects': (p) => {
      on();
      const ids = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined);
      return { bear: d.bears.setProjects(str(p, 'bear'), { add: ids('add'), remove: ids('remove') }) };
    },
    // From a thread's tb bears ask, fromThreadId is the caller itself,
    // whatever it says.
    'bears.mention': (p) => {
      on();
      if (!d.mention) throw fail('Mentions are not wired on this runner.', ErrorCode.other);
      const from = typeof p._caller === 'string' ? p._caller : typeof p.fromThreadId === 'string' ? p.fromThreadId : undefined;
      return d.mention({ bear: str(p, 'bear'), text: str(p, 'text'), ...(from ? { fromThreadId: from } : {}) });
    },
    'bears.delete': async (p) => {
      on();
      const bear = d.bears.get(str(p, 'bear'), { faces: false });
      await d.revokeHooks?.(bear.folder).catch(() => undefined);
      return await d.bears.delete(bear.id);
    },
  };
}
