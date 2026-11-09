// The profile page's changelog (profile.tsx): one person's public commits
// to their Threadbear repo, read by the visitor's browser from GitHub's
// public API, newest first and grouped by day. GitHub only answers for a
// public repo without a token, so a private one shows nothing.

export type Change = {
  sha: string;
  /** The subject's "Area: " prefix, when it has a short one. */
  area?: string;
  text: string;
  /** The rest of the message, for the entry's tooltip. */
  body?: string;
  url: string;
  /** Local YYYY-MM-DD of when it was written (rebases keep that date). */
  day: string;
};

export type ChangeDay = { day: string; changes: Change[] };

type ApiCommit = {
  sha?: unknown;
  html_url?: unknown;
  parents?: unknown;
  commit?: { message?: unknown; author?: { date?: unknown } | null };
};

/** At most 100 a page, GitHub's own limit. */
export const PAGE_SIZE = 100;

/** The API address for one page of `author`'s commits on `repo`'s default branch. */
export function commitsUrl(repo: string, author: string, page: number): string {
  const [owner, name] = repo.split('/');
  return `https://api.github.com/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/commits?author=${encodeURIComponent(author)}&per_page=${PAGE_SIZE}&page=${page}`;
}

/** "Profile page: its addresses as two rows" is area Profile page. Only a short, plain prefix counts. */
export function splitSubject(subject: string): { area?: string; text: string } {
  const m = /^([^:()[\]`]{2,32}):\s+(\S.*)$/.exec(subject.trim());
  if (!m || /https?$/i.test(m[1]!)) return { text: subject.trim() };
  // Read on its own after the chip, so it starts as a sentence does.
  return { area: m[1]!.trim(), text: m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1) };
}

function localDay(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** GitHub's answer as changes, leaving out merges and anything malformed. */
export function readCommits(json: unknown): Change[] {
  if (!Array.isArray(json)) return [];
  const out: Change[] = [];
  for (const c of json as ApiCommit[]) {
    const message = typeof c?.commit?.message === 'string' ? c.commit.message : '';
    const date = typeof c?.commit?.author?.date === 'string' ? c.commit.author.date : '';
    const sha = typeof c?.sha === 'string' && /^[0-9a-f]{7,40}$/.test(c.sha) ? c.sha : '';
    const url = typeof c?.html_url === 'string' && c.html_url.startsWith('https://github.com/') ? c.html_url : '';
    const day = localDay(date);
    if (!message || !sha || !url || !day) continue;
    if (Array.isArray(c.parents) && c.parents.length > 1) continue;
    const [subject = '', ...rest] = message.split('\n');
    if (!subject.trim()) continue;
    // Trailers (Co-Authored-By:, Important:) aren't part of what changed.
    const body = rest
      .filter((l) => !/^[A-Za-z][A-Za-z-]*:\s/.test(l))
      .join('\n')
      .trim();
    out.push({ sha, ...splitSubject(subject), ...(body ? { body: body.slice(0, 600) } : {}), url, day });
  }
  return out;
}

/** Changes in the order given, gathered under their day. */
export function byDay(changes: Change[]): ChangeDay[] {
  const days: ChangeDay[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    const last = days.at(-1);
    const day = last?.day === c.day ? last : days.find((d) => d.day === c.day);
    if (day) day.changes.push(c);
    else days.push({ day: c.day, changes: [c] });
  }
  return days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** Whether GitHub's Link header says there's a next page. */
export function hasNext(link: string | null): boolean {
  return !!link && /<[^>]+>;\s*rel="next"/.test(link);
}

/** What to say when GitHub didn't answer with commits. */
export function trouble(status: number, rateLeft: string | null): string {
  if ((status === 403 || status === 429) && rateLeft === '0') return 'GitHub’s hourly limit for this browser is used up. Try again in a while.';
  if (status === 404) return 'That repository isn’t public on GitHub, so there’s nothing to show.';
  return 'The changelog couldn’t be loaded from GitHub.';
}
