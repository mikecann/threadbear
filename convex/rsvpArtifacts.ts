import { ConvexError, v } from 'convex/values';
import { env, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { ARTIFACT_SLUG } from './artifactPage';
import { RSVP_PATH, rsvpId } from './rsvpPage';

const attendance = v.union(v.literal('yes'), v.literal('no'));
const maxReplies = 100;

async function bySlug(ctx: QueryCtx, slug: string) {
  if (!ARTIFACT_SLUG.test(slug)) return null;
  return ctx.db.query('rsvpArtifacts').withIndex('by_slug', (q) => q.eq('slug', slug)).unique();
}

export const publish = internalMutation({
  args: { title: v.string(), details: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const title = args.title.trim();
    const details = args.details.trim();
    if (!title || title.length > 120 || details.length > 2000) {
      throw new ConvexError('Use a title of 1 to 120 characters and up to 2,000 characters of details.');
    }
    const slug = rsvpId();
    if (await bySlug(ctx, slug)) throw new ConvexError('Could not make a link. Try again.');
    await ctx.db.insert('rsvpArtifacts', { slug, title, details });
    return new URL(RSVP_PATH + slug, env.CONVEX_SITE_URL).href;
  },
});

export const invitation = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.null(), v.object({ title: v.string(), details: v.string() })),
  handler: async (ctx, { slug }) => {
    const item = await bySlug(ctx, slug);
    return item ? { title: item.title, details: item.details } : null;
  },
});

export const submit = internalMutation({
  args: { slug: v.string(), name: v.string(), attendance, request: v.string() },
  returns: v.union(v.literal('saved'), v.literal('invalid'), v.literal('full'), v.literal('missing')),
  handler: async (ctx, args) => {
    const item = await bySlug(ctx, args.slug);
    if (!item) return 'missing';
    const name = args.name.trim();
    if (!name || name.length > 80 || !ARTIFACT_SLUG.test(args.request)) return 'invalid';
    const earlier = await ctx.db.query('artifactRsvps')
      .withIndex('by_invitation_request', (q) => q.eq('invitation', item._id).eq('request', args.request)).unique();
    if (earlier) return 'saved';
    const replies = await ctx.db.query('artifactRsvps')
      .withIndex('by_invitation_request', (q) => q.eq('invitation', item._id)).take(maxReplies);
    if (replies.length >= maxReplies) return 'full';
    await ctx.db.insert('artifactRsvps', { invitation: item._id, request: args.request, name, attendance: args.attendance });
    return 'saved';
  },
});

// The deployment admin can read responses from the CLI. Public HTTP actions
// only call invitation and submit, so the link can't read these rows.
export const submissions = internalQuery({
  args: { slug: v.string() },
  returns: v.array(v.object({ name: v.string(), attendance, submittedAt: v.number() })),
  handler: async (ctx, { slug }) => {
    const item = await bySlug(ctx, slug);
    if (!item) return [];
    const rows = await ctx.db.query('artifactRsvps')
      .withIndex('by_invitation_request', (q) => q.eq('invitation', item._id)).take(maxReplies);
    return rows.map(({ name, attendance, _creationTime }) => ({ name, attendance, submittedAt: _creationTime }));
  },
});
