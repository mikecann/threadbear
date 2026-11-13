// Published Prints, for whoever reads them (docs/protocol.md, "Prints"):
// anyone with a print's link, and the phone and website signed in as the
// user. The runner writes them (sync.ts publishPrint).
import { v } from 'convex/values';
import { query } from './_generated/server';
import { checkPhoneToken } from './lib';

// The print behind a link, for the website's /p/<slug>. The only thing
// here with no sign-in: the slug is the secret, 16 random bytes its runner
// made. Two rows with one slug show neither.
export const view = query({
  args: { slug: v.string() },
  returns: v.union(
    v.object({ state: v.literal('gone') }),
    v.object({ state: v.literal('ok'), title: v.string(), kind: v.string(), version: v.number(), summary: v.string(), html: v.string(), updatedAt: v.string() }),
  ),
  handler: async (ctx, { slug }) => {
    if (!slug || slug.length > 64) return { state: 'gone' as const };
    const rows = await ctx.db
      .query('prints')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .take(2);
    if (rows.length !== 1) return { state: 'gone' as const };
    const { title, kind, version, summary, html, updatedAt } = rows[0]!;
    return { state: 'ok' as const, title, kind, version, summary, html, updatedAt };
  },
});

// The published prints, newest first, without their HTML: for the cards in
// replies and a list, on the phone and the website. At most 200 (the most
// a runner can publish), so the read is bounded.
export const list = query({
  args: { token: v.string() },
  returns: v.array(v.object({ id: v.string(), slug: v.string(), title: v.string(), kind: v.string(), version: v.number(), summary: v.string(), updatedAt: v.string() })),
  handler: async (ctx, { token }) => {
    await checkPhoneToken(ctx, token);
    const rows = await ctx.db.query('prints').take(400);
    return rows
      .map(({ id, slug, title, kind, version, summary, updatedAt }) => ({ id, slug, title, kind, version, summary, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
});
