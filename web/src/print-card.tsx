// A reply's ```print <id>``` block as a card, as the Mac draws one: its title,
// kind, version and summary, with Open for a published Print (its /p/ page).
// A Print that isn't published lives only on the Mac, so the card says that.
// The list comes from prints:list once for the whole site; a shared page
// (no token) has none, and every card there says it's on the Mac.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLiveQuery } from './live';
import { api } from '../../convex/_generated/api';
import * as Icon from './icons';
import { printLabel, type PublishedPrint } from './print-fence';

const Published = createContext<Map<string, PublishedPrint> | undefined>(undefined);

export function PrintsProvider({ token, children }: { token: string; children: ReactNode }) {
  const list = useLiveQuery(api.prints.list, { token });
  const byId = useMemo(() => new Map((list ?? []).map((p) => [p.id, p])), [list]);
  return <Published.Provider value={byId}>{children}</Published.Provider>;
}

export function PrintCard({ id }: { id: string }) {
  const print = useContext(Published)?.get(id);
  if (!print) {
    return (
      <div className="print-card kept" title="Publish it from the Mac to see it here">
        <div className="print-card-text">
          <div className="print-card-title">Print</div>
          <div className="print-card-meta">Kept on the Mac that made it. Publish it there to open it here.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="print-card">
      <div className="print-card-text">
        <div className="print-card-title">{print.title}</div>
        <div className="print-card-meta">
          {printLabel(print.kind)} · v{print.version}
          {print.summary ? ` · ${print.summary}` : ''}
        </div>
      </div>
      <a className="print-card-open" href={`/p/${print.slug}`} target="_blank" rel="noreferrer" title={`Open ${print.title}`}>
        <Icon.Link />
        Open
      </a>
    </div>
  );
}
