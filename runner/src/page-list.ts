// Todo lists and kanban boards (the pages experiment): Prints kept as
// markdown, like docs, that the user can change with a click. A todo list is
// GitHub's task list (`- [ ] item`, `- [x] done`) under optional headings; a
// board is one heading per column with a list item per card.
//
// Prints never run scripts, so a click is a link: `threadbear-print:toggle`
// or `threadbear-print:move`, carrying the version it was drawn from. The Mac
// app catches it, the runner changes the markdown and saves a new version
// (pages.toggleItem, pages.moveCard). Anywhere else (a published page, a
// download) the link goes nowhere and the page is a plain list.
//
// Edits work on the source's own lines, so everything else in it stays
// exactly as the agent or the user wrote it.
import { inline, PAGE_THEME_CSS } from './page-doc.ts';

export const LIST_KINDS = ['todo', 'board'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const lines = (md: string): string[] => md.replace(/\r\n?/g, '\n').split('\n');
const HEADING = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/;
const TASK = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*)$/;
const ITEM = /^\s*[-*+]\s+(?:\[(?: |x|X)\]\s+)?(.*)$/;
// A card or item's words, without links, as the whole row is the link.
const words = (text: string): string => inline(text).replace(/<a\b[^>]*>(.*?)<\/a>/g, '$1');

export type TodoItem = { n: number; line: number; done: boolean; text: string; group?: string };

export function parseTodo(md: string): { items: TodoItem[]; done: number; notes: { line: number; text: string; group?: string }[] } {
  const items: TodoItem[] = [];
  const notes: { line: number; text: string; group?: string }[] = [];
  let group: string | undefined;
  lines(md).forEach((l, line) => {
    const h = HEADING.exec(l);
    if (h) {
      group = h[1]!;
      return;
    }
    const t = TASK.exec(l);
    if (t) {
      items.push({ n: items.length, line, done: t[2] !== ' ', text: t[4]!.trim(), ...(group !== undefined ? { group } : {}) });
      return;
    }
    if (l.trim()) notes.push({ line, text: l.trim(), ...(group !== undefined ? { group } : {}) });
  });
  return { items, done: items.filter((i) => i.done).length, notes };
}

export function toggleItem(md: string, n: number): string {
  const item = parseTodo(md).items[n];
  if (!item) throw new Error(`There's no item ${n} in this list.`);
  const all = md.split('\n');
  all[item.line] = all[item.line]!.replace(TASK, (_, lead: string, box: string, gap: string, rest: string) => `${lead}[${box === ' ' ? 'x' : ' '}]${gap}${rest}`);
  return all.join('\n');
}

export type BoardCard = { n: number; line: number; text: string };
export type BoardColumn = { name: string; line: number; cards: BoardCard[] };

export function parseBoard(md: string): { columns: BoardColumn[] } {
  const columns: BoardColumn[] = [];
  let cards = 0;
  lines(md).forEach((l, line) => {
    const h = HEADING.exec(l);
    if (h) {
      columns.push({ name: h[1]!, line, cards: [] });
      return;
    }
    const c = columns.length ? ITEM.exec(l) : null;
    if (c && c[1]!.trim()) columns.at(-1)!.cards.push({ n: cards++, line, text: c[1]!.trim() });
  });
  return { columns };
}

// The card's own line moves to the end of the column it goes to.
export function moveCard(md: string, n: number, to: number): string {
  const { columns } = parseBoard(md);
  const from = columns.find((c) => c.cards.some((x) => x.n === n));
  const card = from?.cards.find((x) => x.n === n);
  if (!from || !card) throw new Error(`There's no card ${n} on this board.`);
  const target = columns[to];
  if (!target) throw new Error(`There's no column ${to} on this board.`);
  if (target === from) return md;
  const all = md.split('\n');
  const text = all[card.line]!;
  const after = target.cards.length ? target.cards.at(-1)!.line : target.line;
  all.splice(after + 1, 0, text);
  all.splice(card.line + (card.line > after ? 1 : 0), 1);
  return all.join('\n');
}

const page = (title: string, meta: string, css: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_THEME_CSS}
${BASE_CSS}${css}</style>
</head>
<body>
<main>
<header><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></header>
${body}
</main>
</body>
</html>
`;

const BASE_CSS = `main{max-width:760px;margin:auto;padding:48px 24px 64px}header{margin-bottom:8px}.hint{font-size:13px;color:var(--faint);margin:28px 0 0}
h2{font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dim);margin:32px 0 8px}p{margin:0 0 14px}
@media (max-width:600px){main{padding:28px 18px 48px}h1{font-size:30px}}`;

const TODO_CSS = `.progress{display:flex;align-items:center;gap:14px;margin:22px 0 4px;color:var(--dim);font-size:13px}.bar{flex:1;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--text)}
.item{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;margin:0 -12px;border-radius:8px;cursor:pointer;text-decoration:none}.item:hover{background:var(--card)}
.box{flex:none;width:18px;height:18px;margin-top:3px;border:1.5px solid var(--faint);border-radius:5px;display:grid;place-items:center;font-size:12px;line-height:1;color:var(--bg)}
.done .box{background:var(--text);border-color:var(--text)}.done .text{color:var(--faint);text-decoration:line-through;text-decoration-thickness:1px}`;

export function renderTodo(title: string, md: string, meta: string, version: number): string {
  const { items, done, notes } = parseTodo(md);
  const groups: { name?: string; rows: string[] }[] = [];
  const at = (name?: string) => {
    let g = groups.at(-1);
    if (!g || g.name !== name) groups.push((g = { ...(name !== undefined ? { name } : {}), rows: [] }));
    return g;
  };
  const rows = [
    ...items.map((i) => ({ line: i.line, group: i.group, html: `<a class="item${i.done ? ' done' : ''}" href="threadbear-print:toggle?v=${version}&amp;item=${i.n}" title="${i.done ? 'Mark as not done' : 'Mark as done'}"><span class="box">${i.done ? '✓' : ''}</span><span class="text">${words(i.text)}</span></a>` })),
    ...notes.map((n) => ({ line: n.line, group: n.group, html: `<p>${inline(n.text)}</p>` })),
  ].sort((a, b) => a.line - b.line);
  for (const r of rows) at(r.group).rows.push(r.html);
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const body = [
    `<div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span>${done} of ${items.length} done</span></div>`,
    ...groups.map((g) => `${g.name !== undefined ? `<h2>${inline(g.name)}</h2>` : ''}${g.rows.join('\n')}`),
    `<p class="hint">In Threadbear, click an item to tick it. Each change saves a new version.</p>`,
  ].join('\n');
  return page(title, meta, TODO_CSS, body);
}

const BOARD_CSS = `main{max-width:none;padding-left:32px;padding-right:32px}.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(240px,1fr);gap:16px;overflow-x:auto;margin-top:28px;align-items:start}
.col{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:12px}.col h2{margin:4px 4px 12px}.count{color:var(--faint);font-weight:500;margin-left:4px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;font-size:14px;line-height:1.5}.moves{display:flex;justify-content:space-between;margin-top:10px;font-size:12px}
.moves a{color:var(--faint);text-decoration:none;padding:2px 6px;margin:0 -6px;border-radius:6px}.moves a:hover{background:var(--card);color:var(--text)}.empty{color:var(--faint);font-size:13px;padding:6px 4px}`;

export function renderBoard(title: string, md: string, meta: string, version: number): string {
  const { columns } = parseBoard(md);
  const move = (card: number, to: number, label: string) =>
    `<a href="threadbear-print:move?v=${version}&amp;card=${card}&amp;to=${to}" title="Move to ${esc(columns[to]!.name)}">${label}</a>`;
  const cols = columns.map((c, i) => {
    const cards = c.cards.map(
      (x) =>
        `<div class="card">${words(x.text)}<div class="moves"><span>${i > 0 ? move(x.n, i - 1, `← ${esc(columns[i - 1]!.name)}`) : ''}</span><span>${i < columns.length - 1 ? move(x.n, i + 1, `${esc(columns[i + 1]!.name)} →`) : ''}</span></div></div>`,
    );
    return `<section class="col"><h2>${inline(c.name)} <span class="count">${c.cards.length}</span></h2>${cards.join('') || '<div class="empty">Nothing here</div>'}</section>`;
  });
  const body = `<div class="board">${cols.join('')}</div><p class="hint">In Threadbear, use a card's arrows to move it. Each change saves a new version.</p>`;
  return page(title, meta, BOARD_CSS, body);
}
