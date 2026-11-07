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
