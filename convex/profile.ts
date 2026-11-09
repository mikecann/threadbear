// The public profile page (docs/guide.md, "The librarian";
// web/src/profile.tsx). A deployment is one person's, so there's one page
// and no handle: it's at /profile, and with `home` on it's also what
// visitors see at the site's front page. The owner runner writes the one
// row from what Mike turned on in the Librarian page's Customize panel
// (runner/src/public-profile.ts); anyone may read it once it's published.
// Only what he turned on is ever sent, and cleanProfile holds the row to its
// shape whatever a caller sends: no thread titles, prompts, folders or
// project notes have a field to go in.
import { ConvexError, v, type Infer } from 'convex/values';
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { checkPhoneToken, runnerAuth } from './lib';

const LINKS_MAX = 4;
const NUMBERS_MAX = 8;
const DAYS_MAX = 400;
const PROJECTS_MAX = 12;
const CARDS = ['numbers', 'activity', 'github', 'projects'] as const;
const GITHUB = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const link = v.object({ title: v.string(), url: v.string() });
const number = v.object({ key: v.string(), label: v.string(), value: v.string() });
const project = v.object({ title: v.string(), threads: v.number(), symbol: v.optional(v.string()) });
const activity = v.object({ start: v.string(), counts: v.array(v.number()) });

export const profileInput = v.object({
  // Sent by runners from before 9 Nov; kept, never needed.
  handle: v.optional(v.string()),
  published: v.boolean(),
  home: v.optional(v.boolean()),
  name: v.string(),
  bio: v.string(),
  links: v.array(link),
  order: v.array(v.string()),
  pictureId: v.optional(v.id('_storage')),
  backgroundId: v.optional(v.id('_storage')),
  backgroundDim: v.optional(v.number()),
  memberSince: v.optional(v.string()),
  numbers: v.optional(v.array(number)),
  activity: v.optional(activity),
  github: v.optional(v.string()),
  projects: v.optional(v.array(project)),
});
type ProfileInput = Infer<typeof profileInput>;

function bad(message: string): ConvexError<{ kind: string; message: string }> {
  return new ConvexError({ kind: 'badProfile', message });
}

function cut(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The row as it may be kept: every string cut to size, every list capped. */
export function cleanProfile(p: ProfileInput): Omit<ProfileInput, 'handle'> {
  if (p.links.length > LINKS_MAX) throw bad(`At most ${LINKS_MAX} links.`);
  const links = p.links.map((l) => {
    const url = safeUrl(l.url);
    if (!url) throw bad(`A link has to be an http or https address: ${cut(l.url, 80)}`);
    return { title: cut(l.title, 40) || new URL(url).hostname, url: url.slice(0, 300) };
  });
  const order = [...new Set(p.order)].filter((c): c is (typeof CARDS)[number] => (CARDS as readonly string[]).includes(c));
  if (p.github !== undefined && !GITHUB.test(p.github)) throw bad('That isn’t a GitHub user name.');
  if (p.activity && (!DAY.test(p.activity.start) || p.activity.counts.length > DAYS_MAX || p.activity.counts.some((n) => !Number.isFinite(n) || n < 0))) throw bad('The activity is a start day and up to 400 counts.');
  if (p.memberSince !== undefined && !DAY.test(p.memberSince)) throw bad('Member since is a day, YYYY-MM-DD.');
  return {
    published: p.published,
    home: p.published && p.home === true,
    name: cut(p.name, 60),
    bio: cut(p.bio, 160),
    links,
    order,
    ...(p.pictureId ? { pictureId: p.pictureId } : {}),
    ...(p.backgroundId ? { backgroundId: p.backgroundId, backgroundDim: Math.min(0.95, Math.max(0, p.backgroundDim ?? 0.55)) } : {}),
    ...(p.memberSince ? { memberSince: p.memberSince } : {}),
    ...(p.numbers ? { numbers: p.numbers.slice(0, NUMBERS_MAX).map((n) => ({ key: cut(n.key, 30), label: cut(n.label, 40), value: cut(n.value, 40) })) } : {}),
    ...(p.activity ? { activity: { start: p.activity.start, counts: p.activity.counts.map((n) => Math.round(n)) } } : {}),
    ...(p.github ? { github: p.github } : {}),
    ...(p.projects ? { projects: p.projects.slice(0, PROJECTS_MAX).map((x) => ({ title: cut(x.title, 80), threads: Math.max(0, Math.round(x.threads)), ...(x.symbol ? { symbol: cut(x.symbol, 60) } : {}) })) } : {}),
  };
}

async function theRow(ctx: QueryCtx | MutationCtx): Promise<Doc<'profile'> | null> {
  return ctx.db.query('profile').first();
}

async function dropFile(ctx: MutationCtx, id: Id<'_storage'> | undefined, keep: (Id<'_storage'> | undefined)[]): Promise<void> {
  if (!id || keep.includes(id)) return;
  if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
}

/** Where the runner uploads the page's picture and background. Owner only. */
export const uploadUrl = mutation({
  args: { key: v.string() },
  returns: v.string(),
  handler: async (ctx, { key }) => {
    await runnerAuth(ctx, key, 'profileUploadUrl');
    return ctx.storage.generateUploadUrl();
  },
});

/**
 * The whole row, replaced; with no profile, the row and its pictures go.
 * Owner only: a runner key can't write anyone's page.
 */
export const publish = mutation({
  args: { key: v.string(), profile: v.optional(profileInput) },
  returns: v.null(),
  handler: async (ctx, { key, profile }) => {
    await runnerAuth(ctx, key, 'profilePublish');
    const old = await theRow(ctx);
    if (!profile) {
      if (old) {
        await ctx.db.delete(old._id);
        await dropFile(ctx, old.pictureId, []);
        await dropFile(ctx, old.backgroundId, []);
      }
      return null;
    }
    const row = { ...cleanProfile(profile), updatedAt: Date.now() };
    for (const id of [row.pictureId, row.backgroundId]) if (id && !(await ctx.db.system.get(id))) throw bad('A picture it names was never uploaded.');
    if (old) {
      const was = [old.pictureId, old.backgroundId];
      await ctx.db.replace(old._id, row);
      for (const id of was) await dropFile(ctx, id, [row.pictureId, row.backgroundId]);
    } else {
      await ctx.db.insert('profile', row);
    }
    return null;
  },
});

const page = v.object({
  // Not published: only Mike's own signed-in browser gets the page.
  preview: v.boolean(),
  // Shown at the site's front page to visitors.
  home: v.boolean(),
  name: v.string(),
  bio: v.string(),
  links: v.array(link),
  order: v.array(v.string()),
  picture: v.optional(v.string()),
  background: v.optional(v.string()),
  backgroundDim: v.optional(v.number()),
  memberSince: v.optional(v.string()),
  numbers: v.optional(v.array(number)),
  activity: v.optional(activity),
  github: v.optional(v.string()),
  projects: v.optional(v.array(project)),
});

async function isMike(ctx: QueryCtx, token?: string): Promise<boolean> {
  if (!token) return false;
  try {
    await checkPhoneToken(ctx, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * The page, for anyone once published, or for Mike's signed-in browser
 * before then. Null: there's no page to show. `handle` is what /@<handle>
 * links from before 9 Nov send; any handle opens the one page.
 */
export const view = query({
  args: { token: v.optional(v.string()), handle: v.optional(v.string()) },
  returns: v.union(v.null(), page),
  handler: async (ctx, { token }) => {
    const row = await theRow(ctx);
    if (!row) return null;
    if (!row.published && !(await isMike(ctx, token))) return null;
    const picture = row.pictureId ? await ctx.storage.getUrl(row.pictureId) : null;
    const background = row.backgroundId ? await ctx.storage.getUrl(row.backgroundId) : null;
    const { _id, _creationTime, handle, pictureId, backgroundId, backgroundDim, updatedAt, published, home, ...rest } = row;
    return {
      ...rest,
      preview: !published,
      home: published && home === true,
      ...(picture ? { picture } : {}),
      ...(background ? { background, ...(backgroundDim === undefined ? {} : { backgroundDim }) } : {}),
    };
  },
});

/**
 * For http.ts's link-preview tags: the published page, or null. `home`: the
 * front page asking, which gets the tags only when the page is shown there.
 */
export const card = internalQuery({
  args: { home: v.optional(v.boolean()) },
  returns: v.union(v.null(), v.object({ title: v.string(), description: v.string(), image: v.optional(v.string()) })),
  handler: async (ctx, { home }) => {
    const row = await theRow(ctx);
    if (!row?.published || (home && !row.home)) return null;
    const image = row.pictureId ? await ctx.storage.getUrl(row.pictureId) : null;
    return { title: row.name || 'Profile', description: row.bio, ...(image ? { image } : {}) };
  },
});
