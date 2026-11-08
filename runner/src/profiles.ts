// Profiles (docs/guide.md, "Profiles"): more than one whole Threadbear setup
// on one Mac, such as Work beside Personal. Each has its own runner (its own
// LaunchAgent, port and data folder), Convex deployment, logins, skills,
// projects and notes; only the app's looks are shared. The first setup, in
// the usual data folder, is Personal and has no profile in its runner.json.
//
// profiles.json, in Personal's folder, lists the others: names, folders,
// ports and labels, never a secret. tb profile add/remove/list and the
// app's Settings > Profiles read and write it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultHome, readRunnerJson, writeRunnerJson, profileFrom, DEFAULT_PORT, type RunnerJson } from './config.ts';
import { ErrorCode, RpcError } from './protocol.ts';

export const PERSONAL_ID = 'personal';
export const LABEL_PREFIX = 'com.mikerosoft.threadbear.runner';

export type ProfileEntry = {
  id: string;
  name: string;
  home: string;
  port: number;
  label: string;
  createdAt: string;
};

type ProfilesFile = { profiles: ProfileEntry[] };

export const registryFile = (base = defaultHome()) => path.join(base, 'profiles.json');

/** Where new profiles' folders go, beside Personal's. */
export const profilesRoot = () => path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear Profiles');

function read(base: string): ProfilesFile {
  try {
    const v = JSON.parse(fs.readFileSync(registryFile(base), 'utf8')) as ProfilesFile;
    return { profiles: Array.isArray(v.profiles) ? v.profiles.filter((p) => p && typeof p.id === 'string' && typeof p.home === 'string') : [] };
  } catch {
    return { profiles: [] };
  }
}

function write(base: string, file: ProfilesFile): void {
  const target = registryFile(base);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Every profile on this Mac, Personal first. */
export function listProfiles(base = defaultHome()): ProfileEntry[] {
  const own = readRunnerJson(base);
  const personal: ProfileEntry = { id: PERSONAL_ID, name: 'Personal', home: base, port: own.port ?? DEFAULT_PORT, label: LABEL_PREFIX, createdAt: '' };
  return [personal, ...read(base).profiles];
}

/** A profile by id or name (any case). */
export function findProfile(q: string, base = defaultHome()): ProfileEntry | undefined {
  const key = q.trim().toLowerCase();
  return listProfiles(base).find((p) => p.id === key || p.name.toLowerCase() === key);
}

/** "Work Stuff" → "work-stuff", made unique among the profiles there are. */
export function profileId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'profile';
  let id = base === PERSONAL_ID ? `${base}-2` : base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The next port above Personal's that no profile has. */
export function freePort(taken: number[]): number {
  let port = DEFAULT_PORT + 1;
  while (taken.includes(port)) port++;
  return port;
}

export type AddOptions = { base?: string; root?: string; now?: Date; defaultCwd?: string };

/**
 * Makes a profile's folder and runner.json and lists it, but installs
 * nothing: installProfile starts its runner. Its runner.json has no
 * backend yet (it runs on this Mac only until Convex is connected), its
 * own port, and a folder of its own for new threads.
 */
export function addProfile(name: string, opts: AddOptions = {}): ProfileEntry {
  const base = opts.base ?? defaultHome();
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) throw new Error('A profile needs a name.');
  const all = listProfiles(base);
  if (all.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There's a profile called ${clean} already.`);
  const id = profileId(clean, all.map((p) => p.id));
  const home = path.join(opts.root ?? profilesRoot(), id);
  if (fs.existsSync(path.join(home, 'runner.json'))) throw new Error(`${home} is in use already.`);
  const entry: ProfileEntry = { id, name: clean, home, port: freePort(all.map((p) => p.port)), label: `${LABEL_PREFIX}.${id}`, createdAt: (opts.now ?? new Date()).toISOString() };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const json: RunnerJson = {
    profile: { id, name: clean },
    port: entry.port,
    defaults: { cwd: opts.defaultCwd ?? path.join(os.homedir(), 'ThreadbearThreads', clean) },
  };
  writeRunnerJson(home, json);
  const file = read(base);
  file.profiles.push(entry);
  write(base, file);
  return entry;
}

/** Takes a profile off the list. Its folder stays unless `deleteFiles`. */
export function removeProfile(id: string, opts: { base?: string; deleteFiles?: boolean } = {}): ProfileEntry {
  const base = opts.base ?? defaultHome();
  if (id === PERSONAL_ID) throw new Error("Personal is this Mac's first setup and can't be removed.");
  const file = read(base);
  const entry = file.profiles.find((p) => p.id === id);
  if (!entry) throw new Error(`No profile ${id}.`);
  file.profiles = file.profiles.filter((p) => p.id !== id);
  write(base, file);
  // Only ever a folder this list made, with this profile's runner.json in it.
  if (opts.deleteFiles && profileFrom(readRunnerJson(entry.home).profile)?.id === id) fs.rmSync(entry.home, { recursive: true, force: true });
  return entry;
}

/** The checkout the running release was built from, which has install-runner.sh. */
export function checkoutOf(base = defaultHome()): string | undefined {
  try {
    const release = JSON.parse(fs.readFileSync(path.join(base, 'runner', 'current', 'release.json'), 'utf8')) as { checkout?: string };
    if (release.checkout && fs.existsSync(path.join(release.checkout, 'runner', 'scripts', 'install-runner.sh'))) return release.checkout;
  } catch {}
  return undefined;
}

/** Installs (or with `uninstall`, removes) a profile's runner LaunchAgent. */
export function installProfile(entry: ProfileEntry, opts: { checkout: string; uninstall?: boolean; run?: typeof spawnSync }): { ok: boolean; output: string } {
  const script = path.join(opts.checkout, 'runner', 'scripts', 'install-runner.sh');
  const args = ['--home', entry.home, '--label', entry.label, '--port', String(entry.port), ...(opts.uninstall ? ['--uninstall'] : [])];
  const r = (opts.run ?? spawnSync)(script, args, { cwd: path.join(opts.checkout, 'runner'), encoding: 'utf8', timeout: 15 * 60_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

// ---------------------------------------------------------- Settings > Profiles
//
// The app's Settings > Profiles, through whichever runner the app is on
// (profiles are this Mac's, so any of its runners can list and make them).
// Making one is tb profile add's folder, then scripts/setup.mjs in profile
// mode, run in the background: it signs the profile's own Convex CLI in
// (the browser opens), makes its Convex project, keys and backend, and
// installs its runner. Its last lines show as it goes, and a Convex login
// with several teams stops it with the list, to pick one and run it again.

export type ProfileJob = {
  id: string;
  state: 'running' | 'done' | 'failed' | 'needs-team';
  lines: string[];
  teams?: { name: string; slug: string }[];
  message?: string;
};

export type ProfileListItem = ProfileEntry & { running: boolean; convexUrl?: string; job?: ProfileJob };

type Spawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', fn: (code: number | null) => void): unknown;
};

export type ProfileJobsDeps = {
  base?: string;
  root?: string; // where new profiles' folders go (profilesRoot)
  checkout: () => string | undefined;
  spawn: Spawn;
  reachable: (port: number) => Promise<boolean>;
  changed: () => void;
  node?: string;
};

export class ProfileJobs {
  private jobs = new Map<string, ProfileJob>();
  private deps: ProfileJobsDeps;

  constructor(deps: ProfileJobsDeps) {
    this.deps = deps;
  }

  private get base() {
    return this.deps.base ?? defaultHome();
  }

  async list(): Promise<{ profiles: ProfileListItem[] }> {
    const all = listProfiles(this.base);
    const profiles = await Promise.all(
      all.map(async (p) => {
        const url = readRunnerJson(p.home).sync as { url?: string } | undefined;
        return { ...p, running: await this.deps.reachable(p.port), ...(url?.url ? { convexUrl: url.url } : {}), ...(this.jobs.get(p.id) ? { job: this.jobs.get(p.id) } : {}) };
      }),
    );
    return { profiles };
  }

  /** Makes the profile and starts its setup; the job says how it goes. */
  create(p: { name: string; project?: string; team?: string }): { profile: ProfileEntry } {
    const entry = addProfile(p.name, { base: this.base, ...(this.deps.root ? { root: this.deps.root } : {}) });
    this.setup(entry, { project: p.project, team: p.team });
    return { profile: entry };
  }

  /** Runs a profile's setup again: after a failure, or with the team picked. */
  retry(p: { id: string; team?: string; project?: string }): { ok: true } {
    const entry = listProfiles(this.base).find((x) => x.id === p.id);
    if (!entry || entry.id === PERSONAL_ID) throw new Error(`No profile ${p.id}.`);
    if (this.jobs.get(entry.id)?.state === 'running') throw new Error(`${entry.name} is being set up already.`);
    this.setup(entry, { team: p.team, project: p.project });
    return { ok: true };
  }

  private setup(entry: ProfileEntry, o: { project?: string; team?: string }): void {
    const checkout = this.deps.checkout();
    const job: ProfileJob = { id: entry.id, state: 'running', lines: [] };
    this.jobs.set(entry.id, job);
    if (!checkout) {
      job.state = 'failed';
      job.message = "Couldn't find the threadbear checkout to set it up from.";
      this.deps.changed();
      return;
    }
    const project = (o.project?.trim() || `threadbear-${entry.id}`).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const args = [
      path.join(checkout, 'scripts', 'setup.mjs'), '--yes', '--home', entry.home, '--profile', entry.id, '--label', entry.label,
      '--port', String(entry.port), '--project', project, '--name', entry.name, ...(o.team ? ['--team', o.team] : []),
    ];
    const child = this.deps.spawn(this.deps.node ?? process.execPath, args, { cwd: checkout, env: { ...process.env, THREADBEAR_NODE: this.deps.node ?? process.execPath } });
    let all = '';
    const take = (chunk: Buffer | string) => {
      all += chunk.toString();
      const lines = all.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter(Boolean);
      job.lines = lines.slice(-12);
      this.deps.changed();
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('close', (code) => {
      const teams = [...all.matchAll(/^\s+- (.+) \(([a-z0-9-]+)\)$/gm)].map((m) => ({ name: m[1], slug: m[2] }));
      if (code === 0) job.state = 'done';
      else if (teams.length > 1 && /team/i.test(all) && !o.team) {
        job.state = 'needs-team';
        job.teams = teams;
        job.message = 'Your Convex login has several teams. Pick the one for this profile.';
      } else {
        job.state = 'failed';
        job.message = job.lines.at(-1) ?? `setup stopped (exit ${code})`;
      }
      this.deps.changed();
    });
  }

  rename(p: { id: string; name: string }): { profile: ProfileEntry } {
    return { profile: renameProfile(p.id, p.name, this.base) };
  }

  /** Stops a profile's runner and takes it off the list (its folder stays unless deleteFiles). */
  remove(p: { id: string; deleteFiles?: boolean }): { profile: ProfileEntry } {
    const entry = listProfiles(this.base).find((x) => x.id === p.id);
    if (!entry) throw new Error(`No profile ${p.id}.`);
    if (entry.id === PERSONAL_ID) throw new Error("Personal is this Mac's first setup and can't be removed.");
    const checkout = this.deps.checkout();
    if (checkout) installProfile(entry, { checkout, uninstall: true });
    this.jobs.delete(entry.id);
    return { profile: removeProfile(entry.id, { base: this.base, deleteFiles: p.deleteFiles }) };
  }
}

/** A new name for a profile, in the list and its runner.json (its id and folder stay). */
export function renameProfile(id: string, name: string, base = defaultHome()): ProfileEntry {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) throw new Error('A profile needs a name.');
  if (id === PERSONAL_ID) throw new Error('Personal keeps its name.');
  const file = read(base);
  const entry = file.profiles.find((p) => p.id === id);
  if (!entry) throw new Error(`No profile ${id}.`);
  if (listProfiles(base).some((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase())) throw new Error(`There's a profile called ${clean} already.`);
  entry.name = clean;
  write(base, file);
  const json = readRunnerJson(entry.home);
  if (json.profile) writeRunnerJson(entry.home, { ...json, profile: { ...json.profile, name: clean } });
  return entry;
}

export function profileMethods(jobs: ProfileJobs): Record<string, (p: Record<string, unknown>) => unknown> {
  const str = (p: Record<string, unknown>, k: string, required = true) => {
    const v = p[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || (required && !v.trim())) throw new RpcError(ErrorCode.badParams, `${k} must be a string`);
    return v;
  };
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw new RpcError(ErrorCode.badParams, e instanceof Error ? e.message : String(e));
    }
  };
  return {
    'profiles.list': () => jobs.list(),
    'profiles.create': (p) => wrap(() => jobs.create({ name: str(p, 'name')!, project: str(p, 'project', false), team: str(p, 'team', false) })),
    'profiles.retry': (p) => wrap(() => jobs.retry({ id: str(p, 'id')!, team: str(p, 'team', false), project: str(p, 'project', false) })),
    'profiles.rename': (p) => wrap(() => jobs.rename({ id: str(p, 'id')!, name: str(p, 'name')! })),
    'profiles.remove': (p) => wrap(() => jobs.remove({ id: str(p, 'id')!, deleteFiles: p.deleteFiles === true })),
  };
}
