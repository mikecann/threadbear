// A published Print (/p/<slug>; docs/protocol.md, "Prints"): a chart, a
// dashboard, a report or a doc a thread made, that its owner chose to
// publish. For anyone with the link, signed in or not. The print is drawn
// in a frame that can't run scripts, load anything or go anywhere
// (print-doc.ts), filling the window under a one-line header.
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from './live';
import { api } from '../../convex/_generated/api';
import { printDoc } from './print-doc';

const label = (kind: string) => (kind === 'page' ? 'Print' : kind.charAt(0).toUpperCase() + kind.slice(1));

export function PrintPage({ slug }: { slug: string }) {
  const data = useLiveQuery(api.prints.view, { slug });
  // Keeps the last version on screen while a new one loads.
  const [shown, setShown] = useState<typeof data>(undefined);
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);
  const title = shown?.state === 'ok' ? shown.title : undefined;
  useEffect(() => {
    document.title = title ? `${title} · Threadbear` : 'Threadbear';
  }, [title]);
  const doc = useMemo(() => (shown?.state === 'ok' ? printDoc(shown.html) : ''), [shown]);

  if (!shown) return <div className="pad muted">Loading…</div>;
  if (shown.state === 'gone') {
    return (
      <main className="signin">
        <img src="/icon.png" alt="" width={72} height={72} />
        <h1>This link doesn’t work</h1>
        <p className="muted">The print may not be published any more.</p>
      </main>
    );
  }
  const when = new Date(shown.updatedAt);
  return (
    <div className="print-page">
      <header className="print-bar">
        <img src="/icon.png" alt="" width={20} height={20} />
        <strong>{shown.title}</strong>
        <span className="muted">
          {label(shown.kind)} · v{shown.version}
          {Number.isNaN(when.getTime()) ? '' : ` · ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
        </span>
      </header>
      <iframe className="print-frame" title={shown.title} sandbox="" referrerPolicy="no-referrer" srcDoc={doc} />
    </div>
  );
}
