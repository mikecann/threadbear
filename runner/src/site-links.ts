// A site an agent published, for its projects' links (docs/protocol.md,
// "Projects", "Links"): when a deploy or publish command's output gives a
// Convex-hosted site (https://<deployment>.convex.app), it's added to every
// project the thread is in as "Live site", so it's at the top of each of
// their threads' Highlights. A *.convex.site address is the deployment's
// HTTP actions, not a site, so it never counts; nor does a site that's only
// mentioned in a reply.

/** A command that publishes something: a deploy, a publish, a hosting upload. */
export function isPublishCommand(command: string): boolean {
  return /\b(deploy|publish|hosting|release)\b/i.test(command);
}

/** The Convex-hosted sites in a command's output, as their origins, once each. */
export function siteUrls(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/https:\/\/([a-z0-9][a-z0-9-]{0,62})\.convex\.app(?![a-z0-9.-])/gi)) {
    out.add(`https://${m[1].toLowerCase()}.convex.app`);
  }
  return [...out];
}

export const SITE_LINK_TITLE = 'Live site';
