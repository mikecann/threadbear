// The public profile page, /@<handle> (convex/profile.ts; docs/guide.md,
// "The librarian"). For anyone once Mike publishes it from the Librarian
// page's Customize panel; until then, only this browser when it's signed in
// as him, with a line saying so. It shows only what the backend's row has,
// and the row has only what he turned on.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../convex/_generated/api';
import type { FunctionReturnType } from 'convex/server';
import { useLiveQuery } from './live';
import { level, weeks, type Day } from './profile-grid';

type Page = NonNullable<FunctionReturnType<typeof api.profile.view>>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ProfilePage({ handle, token }: { handle: string; token: string | null }) {
  const page = useLiveQuery(api.profile.view, { handle, ...(token ? { token } : {}) });
  useEffect(() => {
    document.title = page ? `${page.name || `@${page.handle}`} · Threadbear` : 'Threadbear';
  }, [page]);
  if (page === undefined) return <div className="pad muted">Loading…</div>;
  if (page === null) {
    return (
      <main className="signin">
        <img src="/icon.png" alt="" width={72} height={72} />
        <h1>This profile is private</h1>
        <p className="muted">Or there's no profile at this address.</p>
      </main>
    );
  }
  return <Profile page={page} />;
}

export function Profile({ page }: { page: Page }) {
  const style = page.background ? ({ '--profile-bg': `url("${page.background}")`, '--profile-dim': String(page.backgroundDim ?? 0.55) } as React.CSSProperties) : undefined;
  return (
    <div className={page.background ? 'profile has-bg' : 'profile'} style={style}>
      {page.preview && <div className="profile-preview">Only you can see this page. Publish it from the Librarian page's Customize panel in Threadbear.</div>}
      <main className="profile-main">
        <header className="profile-head">
          {page.picture && <img className="profile-pic" src={page.picture} alt="" width={120} height={120} />}
          <div>
            <h1>{page.name || `@${page.handle}`}</h1>
            <div className="muted">
              @{page.handle}
              {page.memberSince && <> · Using Threadbear since {monthYear(page.memberSince)}</>}
            </div>
            {page.bio && <p className="profile-bio">{page.bio}</p>}
            {page.links.length > 0 && (
              <nav className="profile-links">
                {page.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow">
                    {l.title}
                  </a>
                ))}
              </nav>
            )}
          </div>
        </header>
        {page.order.map((card) => {
          if (card === 'numbers' && page.numbers?.length) return <Numbers key={card} numbers={page.numbers} />;
          if (card === 'activity' && page.activity) return <ThreadbearActivity key={card} activity={page.activity} />;
          if (card === 'github' && page.github) return <GitHubActivity key={card} user={page.github} />;
          if (card === 'projects' && page.projects?.length) return <Projects key={card} projects={page.projects} />;
          return null;
        })}
        <footer className="profile-foot muted">
          Made with <a href="https://threadbear.mikecann.app">Threadbear</a>
        </footer>
      </main>
    </div>
  );
}

function Numbers({ numbers }: { numbers: NonNullable<Page['numbers']> }) {
  return (
    <section className="profile-card profile-numbers">
      {numbers.map((n) => (
        <div key={n.key}>
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
    <section className="profile-card">
      <h2>Threadbear activity</h2>
      <Grid days={days} tone="threadbear" unit="thread" />
      <div className="profile-note muted">{total.toLocaleString('en-US')} threads in the last year</div>
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
    <section className="profile-card">
      <h2>
        GitHub activity{' '}
        <a className="muted" href={`https://github.com/${user}`} target="_blank" rel="noopener noreferrer">
          @{user}
        </a>
      </h2>
      {days === undefined && <div className="muted">Loading…</div>}
      {days === null && <div className="muted">GitHub activity couldn't be loaded.</div>}
      {days && (
        <>
          <Grid days={days} tone="github" unit="contribution" link={(d) => `https://github.com/${user}?tab=overview&from=${d}&to=${d}`} />
          <div className="profile-note muted">{total.toLocaleString('en-US')} contributions in the last year</div>
        </>
      )}
    </section>
  );
}

function Projects({ projects }: { projects: NonNullable<Page['projects']> }) {
  return (
    <section className="profile-card">
      <h2>Projects</h2>
      {projects.map((p) => (
        <div className="profile-project" key={p.title}>
          <span>{p.title}</span>
          <span className="muted">
            {p.threads} {p.threads === 1 ? 'thread' : 'threads'}
          </span>
        </div>
      ))}
    </section>
  );
}

function Grid({ days, tone, unit, link }: { days: Day[]; tone: 'threadbear' | 'github'; unit: string; link?: (date: string) => string }) {
  const cols = useMemo(() => weeks(days), [days]);
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days]);
  // On a narrow screen the grid scrolls; it starts at today, the end.
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (wrap.current) wrap.current.scrollLeft = wrap.current.scrollWidth;
  }, [cols]);
  return (
    <div className="profile-grid-wrap" ref={wrap}>
      <div className={`profile-grid ${tone}`} role="img" aria-label={`${unit}s per day over the last year`}>
        {cols.map((col, i) => {
          const firstOfMonth = col.find((d) => d && d.date.endsWith('-01'));
          return (
            <div className="profile-col" key={i}>
              <div className="profile-month">{firstOfMonth ? MONTHS[Number(firstOfMonth.date.slice(5, 7)) - 1] : ''}</div>
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
