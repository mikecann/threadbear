// The public profile page, <site>/@<handle> (docs/guide.md, "The
// librarian"; convex/profile.ts; web/src/profile.tsx). The Mac app's
// Customize panel sends what Mike chose (`profilePage.update`); this keeps it in
// profile.json, works out the page's numbers and activity from the
// runner's own threads, and writes the backend's one row: now, and again
// within the hour whenever what it would send has changed.
//
// Only what's turned on goes: the activity is a count of threads a day, the
// numbers are counts, a project is its title, icon symbol and thread count.
// Never a thread's title, prompt, folder or reply, and threads in a private
// folder (Settings > Models) aren't counted at all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Project, ThreadSummary } from './protocol.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { phonePicture } from './project-icons.ts';

export const PROFILE_PARTS = ['picture', 'background', 'activity', 'github', 'numbers', 'projects', 'memberSince'] as const;
export type ProfilePart = (typeof PROFILE_PARTS)[number];
export const PROFILE_NUMBERS = [
  { key: 'threads', label: 'Threads this year' },
  { key: 'activeDays', label: 'Active days' },
  { key: 'streak', label: 'Longest streak' },
  { key: 'projects', label: 'Projects' },
  { key: 'models', label: 'Models used' },
] as const;
const CARDS = ['numbers', 'activity', 'github', 'projects'] as const;
/** 53 weeks and a day, so the grid's first column is always whole. */
export const ACTIVITY_DAYS = 372;
const RESEND_MS = 60 * 60 * 1000;

export type ProfileSettings = {
  published: boolean;
  handle: string;
  name: string;
  bio: string;
  links: { title: string; url: string }[];
  show: ProfilePart[];
  numbers: string[];
  projectIds: string[];
  /** The cards top to bottom, as the Librarian page lays its parts out. */
  order: string[];
  picturePath?: string;
  backgroundPath?: string;
  backgroundDim?: number;
  githubUser?: string;
};

export type ProfileStatus = {
  profile: ProfileSettings | null;
  url?: string;
  sentAt?: string;
  problem?: string;
};

type Saved = { settings?: ProfileSettings; files?: Record<string, { hash: string; storageId: string }>; sentHash?: string; sentAt?: string };

export type ProfileBackend = {
  offReason(): string | undefined;
  site(): string | undefined;
  publishProfile(profile: Record<string, unknown> | undefined): Promise<void>;
  uploadProfilePicture(bytes: Uint8Array, mediaType: string): Promise<string>;
};

export type ProfileDeps = {
  home: string;
  backend: () => ProfileBackend | undefined;
  threads: () => ThreadSummary[];
  projects: () => Project[];
  isPrivate: (cwd: string) => boolean;
  clock: Clock;
  log: Logger;
};

function fail(message: string): RpcError {
  return new RpcError(ErrorCode.badParams, message);
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** What `profilePage.update` was sent, checked and cut to size. */
export function readSettings(p: Record<string, unknown>): ProfileSettings {
  if (typeof p.published !== 'boolean') throw fail('published is true or false');
  const handle = str(p.handle, 40).replace(/^@/, '').toLowerCase();
  if (handle.length < 3 || handle.length > 30 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) throw fail('A handle is 3 to 30 lowercase letters, numbers and single hyphens.');
  const links = Array.isArray(p.links) ? p.links : [];
  if (links.length > 4) throw fail('At most 4 links.');
  const list = (v: unknown, of: readonly string[] | undefined, max: number): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && (!of || of.includes(x))))].slice(0, max) : []);
  const file = (v: unknown): string | undefined => (typeof v === 'string' && path.isAbsolute(v) ? v : undefined);
  const github = str(p.githubUser, 39);
  return {
    published: p.published,
    handle,
    name: str(p.name, 60),
    bio: str(p.bio, 160),
    links: links.map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      const url = str(o.url, 300);
      if (!/^https?:\/\//i.test(url)) throw fail(`A link has to start with https:// or http://: ${url.slice(0, 60)}`);
      return { title: str(o.title, 40), url };
    }),
    show: list(p.show, PROFILE_PARTS, PROFILE_PARTS.length) as ProfilePart[],
    numbers: list(p.numbers, PROFILE_NUMBERS.map((n) => n.key), PROFILE_NUMBERS.length),
    projectIds: list(p.projectIds, undefined, 12),
    order: list(p.order, CARDS, CARDS.length),
    ...(file(p.picturePath) ? { picturePath: file(p.picturePath) } : {}),
    ...(file(p.backgroundPath) ? { backgroundPath: file(p.backgroundPath) } : {}),
    ...(typeof p.backgroundDim === 'number' && Number.isFinite(p.backgroundDim) ? { backgroundDim: Math.min(0.95, Math.max(0, p.backgroundDim)) } : {}),
    ...(github ? { githubUser: github } : {}),
  };
}

/** A local calendar day, YYYY-MM-DD, as the person at this Mac counts days. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayBefore(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d - n, 12).getTime());
}

/** Threads started each day for the last ACTIVITY_DAYS days, oldest first. */
export function activityOf(threads: ThreadSummary[], now: number): { start: string; counts: number[] } {
  const today = localDay(now);
  const start = dayBefore(today, ACTIVITY_DAYS - 1);
  const index = new Map<string, number>();
  for (let i = 0; i < ACTIVITY_DAYS; i++) index.set(dayBefore(today, ACTIVITY_DAYS - 1 - i), i);
  const counts = new Array<number>(ACTIVITY_DAYS).fill(0);
  for (const t of threads) {
    const ms = Date.parse(t.createdAt);
    if (!Number.isFinite(ms)) continue;
    const i = index.get(localDay(ms));
    if (i !== undefined) counts[i]! += 1;
  }
  return { start, counts };
}

/** Every number the page can show, worked out from the year's activity. */
export function numbersOf(threads: ThreadSummary[], projects: Project[], activity: { counts: number[] }): Record<string, string> {
  const year = activity.counts.slice(-365);
  let streak = 0;
  let run = 0;
  for (const n of year) {
    run = n > 0 ? run + 1 : 0;
    streak = Math.max(streak, run);
  }
  const models = new Set(threads.map((t) => t.model ?? t.modelInUse).filter((m): m is string => !!m));
  return {
    threads: year.reduce((a, b) => a + b, 0).toLocaleString('en-US'),
    activeDays: String(year.filter((n) => n > 0).length),
    streak: `${streak} ${streak === 1 ? 'day' : 'days'}`,
    projects: String(projects.filter((p) => !p.archived).length),
    models: String(models.size),
  };
}

const MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export class PublicProfile {
  private file: string;
  private saved: Saved;
  private timer?: TimerHandle;
  private problem?: string;
  private sending?: Promise<void>;

  private deps: ProfileDeps;

  constructor(deps: ProfileDeps) {
    this.deps = deps;
    this.file = path.join(deps.home, 'profile.json');
    this.saved = readJsonSync<Saved>(this.file) ?? {};
  }

  start(): void {
    this.tick(5_000);
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  status(): ProfileStatus {
    const s = this.saved.settings;
    const site = this.deps.backend()?.site();
    return {
      profile: s ?? null,
      ...(s && site ? { url: `${site}/@${s.handle}` } : {}),
      ...(this.saved.sentAt ? { sentAt: this.saved.sentAt } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  /** Saves what Mike chose and sends it now; throws what the backend said. */
  async update(p: Record<string, unknown>): Promise<ProfileStatus> {
    const settings = readSettings(p);
    const backend = this.deps.backend();
    const off = backend ? backend.offReason() : 'sync is off';
    if (off) throw new RpcError(ErrorCode.other, `The profile page lives on your Convex backend, and this runner isn't connected to one (${off}).`);
    this.saved = { ...this.saved, settings };
    this.save();
    await this.send(true);
    if (this.problem) throw new RpcError(ErrorCode.other, this.problem);
    return this.status();
  }

  /** Takes the page down for good: the row, its pictures and the handle. */
  async remove(): Promise<ProfileStatus> {
    const backend = this.deps.backend();
    if (!backend || backend.offReason()) throw new RpcError(ErrorCode.other, "This runner isn't connected to a Convex backend.");
    await backend.publishProfile(undefined);
    this.saved = {};
    this.problem = undefined;
    this.save();
    return this.status();
  }

  /** The row as it would be sent now, without its pictures' storage ids. */
  row(settings: ProfileSettings): Record<string, unknown> {
    const on = new Set(settings.show);
    const threads = this.deps.threads().filter((t) => !this.deps.isPrivate(t.cwd));
    const projects = this.deps.projects();
    const activity = activityOf(threads, this.deps.clock.now());
    const values = numbersOf(threads, projects, activity);
    const first = threads.reduce<number | undefined>((min, t) => {
      const ms = Date.parse(t.createdAt);
      return Number.isFinite(ms) && (min === undefined || ms < min) ? ms : min;
    }, undefined);
    const picked = settings.projectIds.map((id) => projects.find((p) => p.id === id && !p.archived)).filter((p): p is Project => !!p);
    const order = settings.order.filter((c) => (c === 'numbers' ? on.has('numbers') && settings.numbers.length > 0 : c === 'activity' ? on.has('activity') : c === 'github' ? on.has('github') && !!settings.githubUser : on.has('projects') && picked.length > 0));
    return {
      handle: settings.handle,
      published: settings.published,
      name: settings.name,
      bio: settings.bio,
      links: settings.links,
      order,
      ...(on.has('background') && settings.backgroundPath && settings.backgroundDim !== undefined ? { backgroundDim: settings.backgroundDim } : {}),
      ...(on.has('memberSince') && first !== undefined ? { memberSince: localDay(first) } : {}),
      ...(order.includes('numbers') ? { numbers: PROFILE_NUMBERS.filter((n) => settings.numbers.includes(n.key)).map((n) => ({ key: n.key, label: n.label, value: values[n.key] ?? '0' })) } : {}),
      ...(order.includes('activity') ? { activity } : {}),
      ...(order.includes('github') ? { github: settings.githubUser } : {}),
      ...(order.includes('projects') ? { projects: picked.map((p) => ({ title: p.title, threads: p.threadCount, ...(p.icon?.symbol ? { symbol: p.icon.symbol } : {}) })) } : {}),
    };
  }

  private tick(ms: number): void {
    this.timer?.cancel();
    this.timer = this.deps.clock.setTimeout(() => {
      void this.send(false).finally(() => this.tick(RESEND_MS));
    }, ms);
  }

  /** Sends the row when it has changed since the last send (or `force`). */
  private async send(force: boolean): Promise<void> {
    while (this.sending) await this.sending;
    this.sending = this.sendNow(force).finally(() => (this.sending = undefined));
    return this.sending;
  }

  private async sendNow(force: boolean): Promise<void> {
    const settings = this.saved.settings;
    const backend = this.deps.backend();
    if (!settings || !backend || backend.offReason()) return;
    try {
      const on = new Set(settings.show);
      const row = this.row(settings);
      const pictureId = on.has('picture') && settings.picturePath ? await this.stored('picture', settings.picturePath, backend) : undefined;
      const backgroundId = on.has('background') && settings.backgroundPath ? await this.stored('background', settings.backgroundPath, backend) : undefined;
      const full = { ...row, ...(pictureId ? { pictureId } : {}), ...(backgroundId ? { backgroundId } : {}) };
      if (!backgroundId) delete (full as Record<string, unknown>).backgroundDim;
      const hash = crypto.createHash('sha256').update(JSON.stringify(full)).digest('hex');
      if (!force && hash === this.saved.sentHash) return;
      await backend.publishProfile(full);
      this.saved = { ...this.saved, sentHash: hash, sentAt: new Date(this.deps.clock.now()).toISOString() };
      this.problem = undefined;
      this.save();
      this.deps.log.info('profile page sent', { published: settings.published, cards: row.order });
    } catch (e) {
      const raw = (e as { data?: { message?: string } })?.data?.message ?? (e as Error)?.message ?? String(e);
      this.problem = String(raw).replace(/^.*?ConvexError:\s*/s, '').slice(0, 300);
      this.deps.log.warn('profile page not sent', { error: this.problem });
    }
  }

  // A picture's storage id: the one already uploaded while the file is
  // the same, else a new upload (scaled as a project icon is, for SVG).
  private async stored(which: 'picture' | 'background', file: string, backend: ProfileBackend): Promise<string | undefined> {
    const mediaType = MEDIA[path.extname(file).toLowerCase()];
    if (!mediaType || !fs.existsSync(file)) return undefined;
    const bytes = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const had = this.saved.files?.[which];
    if (had?.hash === hash) return had.storageId;
    const pic = await phonePicture(file, mediaType);
    const storageId = await backend.uploadProfilePicture(pic.bytes, pic.mediaType);
    this.saved = { ...this.saved, files: { ...this.saved.files, [which]: { hash, storageId } } };
    this.save();
    return storageId;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteFileSync(this.file, JSON.stringify(this.saved, null, 2) + '\n', 0o600);
  }
}

export function profilePageMethods(p: PublicProfile): Record<string, (params: Record<string, unknown>) => unknown> {
  return {
    'profilePage.get': () => p.status(),
    'profilePage.update': (params) => p.update(params),
    'profilePage.remove': () => p.remove(),
  };
}
