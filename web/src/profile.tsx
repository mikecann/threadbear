// The public profile page (convex/profile.ts; docs/guide.md, "The
// librarian"). A deployment is one person's, so there's one page: at
// /profile, and at the front page for visitors when Mike turns that on
// (FrontPage). Until he publishes it, only this browser sees it when it's
// signed in as him, with a line saying so. It shows only what the
// backend's row has, and the row has only what he turned on.
//
// It looks like Threadbear's own site (site/src/styles.css): warm paper,
// Geist, white cards with a soft lift, the bear's honey brown only where
// it means something, and faint sewn patches behind. Light only, as the
// site is. Styles are under .pf in styles.css.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import { useLiveQuery } from './live';
import { level, weeks, type Day } from './profile-grid';
import { byDay, commitsUrl, hasNext, readCommits, trouble, type Change } from './profile-changelog';

type Page = NonNullable<FunctionReturnType<typeof api.profile.view>>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SITE = 'https://threadbear.mikecann.app';

/** /profile, and /@<handle> links from before there was one page. */
export function ProfilePage({ token }: { token: string | null }) {
  const page = useLiveQuery(api.profile.view, token ? { token } : {});
  if (page === undefined) return <Paper />;
  if (page === null) {
    return (
      <Paper>
        <main className="pf-main pf-empty">
          <img src="/icon.png" alt="" width={72} height={72} />
          <h1>This profile is private</h1>
          <p>Or there isn't one here yet.</p>
        </main>
      </Paper>
    );
  }
  return <Profile page={page} signedIn={!!token} />;
}

/** The front page for someone not signed in: the profile when it's shown there, or `otherwise`. */
export function FrontPage({ otherwise }: { otherwise: ReactNode }) {
  const page = useLiveQuery(api.profile.view, {});
  if (page === undefined) return <Paper />;
  return page?.home ? <Profile page={page} signedIn={false} /> : <>{otherwise}</>;
}

/** The site's paper, on the whole window while a profile is up. */
function Paper({ children }: { children?: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add('pf-html');
    return () => document.documentElement.classList.remove('pf-html');
  }, []);
  return (
    <div className="pf">
      <Patches />
      {children}
    </div>
  );
}

export function Profile({ page, signedIn }: { page: Page; signedIn: boolean }) {
  const title = page.name || 'Profile';
  useEffect(() => {
    document.title = `${title} · Threadbear`;
  }, [title]);
  const backdrop = page.background ? ({ '--pf-bg': `url("${page.background}")`, '--pf-dim': String(page.backgroundDim ?? 0.55) } as React.CSSProperties) : undefined;
  return (
    <Paper>
      <header className="pf-nav-wrap">
        <nav className="pf-nav" aria-label="Profile">
          <span className="pf-brand">
            <img src={page.picture ?? '/icon.png'} alt="" width={32} height={32} />
            <b>{title}</b>
          </span>
          <a className="pf-btn pf-btn-sm" href={SITE}>
            Get Threadbear
          </a>
        </nav>
      </header>
      {page.background && <div className="pf-backdrop" style={backdrop} aria-hidden="true" />}
      <main className="pf-main">
        {page.preview && <p className="pf-preview">Only you can see this page. Turn on Publish in the Librarian page's Customize panel to share it.</p>}
        <section className="pf-hero">
          {page.picture && (
            <span className="pf-pic">
              <img src={page.picture} alt="" width={128} height={128} />
            </span>
          )}
          <h1>{title}</h1>
          {page.bio && <p className="pf-lede">{page.bio}</p>}
          {page.memberSince && <p className="pf-since">Using Threadbear since {monthYear(page.memberSince)}</p>}
          {page.links.length > 0 && (
            <nav className="pf-links" aria-label="Links">
              {page.links.map((l) => (
                <a key={l.url} className="pf-btn pf-btn-ghost" href={l.url} target="_blank" rel="noopener noreferrer nofollow">
                  {l.title}
                </a>
              ))}
            </nav>
          )}
        </section>
        <div className="pf-cards">
          {page.order.map((card) => {
            if (card === 'numbers' && page.numbers?.length) return <Numbers key={card} numbers={page.numbers} />;
            if (card === 'activity' && page.activity) return <ThreadbearActivity key={card} activity={page.activity} />;
            if (card === 'github' && page.github) return <GitHubActivity key={card} user={page.github} />;
            if (card === 'projects' && page.projects?.length) return <Projects key={card} projects={page.projects} />;
            return null;
          })}
        </div>
        {page.changelog && <Changelog repo={page.changelog.repo} author={page.changelog.author} />}
        <footer className="pf-foot">
          <span>
            Made with <a href={SITE}>Threadbear</a>
          </span>
          {!signedIn && <a href="/signin">Sign in</a>}
        </footer>
      </main>
    </Paper>
  );
}

function Numbers({ numbers }: { numbers: NonNullable<Page['numbers']> }) {
  return (
    // One row of up to five on a wide screen, so none is left on its own.
    <section className="pf-numbers" aria-label="Numbers" style={{ '--pf-n': numbers.length } as React.CSSProperties}>
      {numbers.map((n) => (
        <div key={n.key} className="pf-card pf-number">
          <b>{n.value}</b>
          <span>{n.label}</span>
        </div>
      ))}
    </section>
  );
}

function ThreadbearActivity({ activity }: { activity: NonNullable<Page['activity']> }) {
  const days = useMemo(() => activity.counts.map((count, i) => ({ date: addDays(activity.start, i), count })), [activity]);
  const total = activity.counts.slice(-365).reduce((a, b) => a + b, 0);
  return (
    <section className="pf-card pf-section">
      <h2>Threadbear activity</h2>
      <Grid days={days} tone="honey" unit="thread" />
      <p className="pf-note">{total.toLocaleString('en-US')} threads in the last year</p>
    </section>
  );
}

function GitHubActivity({ user }: { user: string }) {
  const [days, setDays] = useState<Day[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`https://github-contributions-api.jogruber.de/v4/${encodeURIComponent(user)}?y=last`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { contributions?: Day[] } | null) => live && setDays(j?.contributions ?? null))
      .catch(() => live && setDays(null));
    return () => {
      live = false;
    };
  }, [user]);
  const total = days?.reduce((a, d) => a + d.count, 0) ?? 0;
  return (
    <section className="pf-card pf-section">
      <h2>
        GitHub activity{' '}
        <a href={`https://github.com/${user}`} target="_blank" rel="noopener noreferrer">
          @{user}
        </a>
      </h2>
      {days === undefined && <p className="pf-note">Loading…</p>}
      {days === null && <p className="pf-note">GitHub activity couldn't be loaded.</p>}
      {days && (
        <>
          <Grid days={days} tone="green" unit="contribution" link={(d) => `https://github.com/${user}?tab=overview&from=${d}&to=${d}`} />
          <p className="pf-note">{total.toLocaleString('en-US')} contributions in the last year</p>
        </>
      )}
    </section>
  );
}

/**
 * The person's public commits to their Threadbear repo, newest first by
 * day. Closed until opened, and only then asks GitHub (the visitor's own
 * browser, no token), so a page view costs nothing. Older loads the next
 * hundred.
 */
function Changelog({ repo, author }: { repo: string; author: string }) {
  const [changes, setChanges] = useState<Change[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'more'>('idle');
  const [problem, setProblem] = useState<string>();
  const page = useRef(0);
  const load = async () => {
    if (state === 'loading') return;
    setState('loading');
    setProblem(undefined);
    try {
      const r = await fetch(commitsUrl(repo, author, page.current + 1), { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) {
        setProblem(trouble(r.status, r.headers.get('x-ratelimit-remaining')));
        setState(page.current === 0 ? 'idle' : 'more');
        return;
      }
      const next = readCommits(await r.json());
      page.current += 1;
      setChanges((had) => [...had, ...next]);
      setState(hasNext(r.headers.get('link')) ? 'more' : 'done');
    } catch {
      setProblem(trouble(0, null));
      setState(page.current === 0 ? 'idle' : 'more');
    }
  };
  const days = useMemo(() => byDay(changes), [changes]);
  const repoUrl = `https://github.com/${repo}`;
  return (
    <details
      className="pf-card pf-changelog"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && page.current === 0) void load();
      }}
    >
      <summary>
        <span className="pf-cl-title">Changelog</span>
        <span className="pf-cl-sub">
          Public commits by @{author} to {repo}
        </span>
      </summary>
      <div className="pf-cl-body">
        {days.map((d) => (
          <section key={d.day} className="pf-cl-day" aria-label={longDay(d.day)}>
            <h3>
              <time dateTime={d.day}>{longDay(d.day)}</time>
            </h3>
            <ul>
              {d.changes.map((c) => (
                <li key={c.sha} title={c.body}>
                  {c.area && <span className="pf-cl-area">{c.area}</span>}
                  <span className="pf-cl-text">{c.text}</span>
                  <a className="pf-cl-sha" href={c.url} target="_blank" rel="noopener noreferrer" aria-label={`Commit ${c.sha.slice(0, 7)} on GitHub`}>
                    {c.sha.slice(0, 7)}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {state === 'loading' && <p className="pf-note">Loading from GitHub…</p>}
        {state === 'done' && days.length === 0 && <p className="pf-note">No public commits by @{author} there yet.</p>}
        {problem && <p className="pf-note">{problem}</p>}
        <div className="pf-cl-foot">
          {(state === 'more' || (state === 'idle' && problem)) && (
            <button type="button" className="pf-cl-more" onClick={() => void load()}>
              {page.current === 0 ? 'Try again' : 'Older changes'}
            </button>
          )}
          <a href={`${repoUrl}/commits?author=${encodeURIComponent(author)}`} target="_blank" rel="noopener noreferrer">
            All on GitHub
          </a>
        </div>
      </div>
    </details>
  );
}

function Projects({ projects }: { projects: NonNullable<Page['projects']> }) {
  return (
    <section className="pf-card pf-section">
      <h2>Projects</h2>
      <ul className="pf-projects">
        {projects.map((p) => (
          <li key={p.title}>
            <span className="pf-badge" aria-hidden="true">
              {p.title.trim().charAt(0).toUpperCase()}
            </span>
            <span className="pf-project-title">{p.title}</span>
            <span className="pf-note">
              {p.threads.toLocaleString('en-US')} {p.threads === 1 ? 'thread' : 'threads'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Grid({ days, tone, unit, link }: { days: Day[]; tone: 'honey' | 'green'; unit: string; link?: (date: string) => string }) {
  const cols = useMemo(() => weeks(days), [days]);
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days]);
  // On a narrow screen the grid scrolls; it starts at today, the end.
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (wrap.current) wrap.current.scrollLeft = wrap.current.scrollWidth;
  }, [cols]);
  return (
    <div className="pf-grid-wrap" ref={wrap}>
      <div className={`pf-grid ${tone}`} role="img" aria-label={`${unit}s per day over the last year`}>
        {cols.map((col, i) => {
          const firstOfMonth = col.find((d) => d && d.date.endsWith('-01'));
          return (
            <div className="pf-col" key={i}>
              <div className="pf-month">{firstOfMonth ? MONTHS[Number(firstOfMonth.date.slice(5, 7)) - 1] : ''}</div>
              {col.map((d, j) => {
                if (!d) return <i key={j} className="empty" />;
                const tip = `${d.count} ${d.count === 1 ? unit : `${unit}s`} on ${longDay(d.date)}`;
                const cell = <i className={`l${level(d.count, max)}`} title={tip} />;
                return link ? (
                  <a key={j} href={link(d.date)} target="_blank" rel="noopener noreferrer" aria-label={tip}>
                    {cell}
                  </a>
                ) : (
                  <span key={j}>{cell}</span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The site's faint sewn patches, half off the page's edges (site/src/layout.html). */
function Patches() {
  const stitch = { fill: 'none', stroke: '#faf8f3', strokeWidth: 2.2, strokeDasharray: '5 4', strokeLinecap: 'round' as const };
  return (
    <div className="pf-patches" aria-hidden="true">
      <svg className="pf-patch p1" viewBox="0 0 120 120">
        <rect x="4" y="4" width="112" height="112" rx="16" fill="currentColor" />
        <rect x="13" y="13" width="94" height="94" rx="8" {...stitch} />
      </svg>
      <svg className="pf-patch p2" viewBox="0 0 120 120">
        <path d="M60 108 14 62a26 26 0 0 1 46-36 26 26 0 0 1 46 36z" fill="currentColor" />
        <path d="M60 96 22 58a17 17 0 0 1 38-24 17 17 0 0 1 38 24z" {...stitch} />
      </svg>
      <svg className="pf-patch p3" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="54" fill="currentColor" />
        <circle cx="60" cy="60" r="44" {...stitch} />
      </svg>
      <svg className="pf-patch p4" viewBox="0 0 120 120">
        <rect x="4" y="30" width="112" height="60" rx="14" fill="currentColor" />
        <rect x="13" y="39" width="94" height="42" rx="6" {...stitch} />
      </svg>
    </div>
  );
}

function addDays(start: string, n: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d + n, 12);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function longDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function monthYear(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
