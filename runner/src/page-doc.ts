// Doc pages (the pages experiment): a page written as markdown, by an agent
// or by the user in the app's editor, drawn here as one static HTML page.
// Both go through this, so a doc looks the same whoever wrote it, and the
// markdown is kept beside it (source.md) for the next edit.
//
// A small, strict subset: headings, paragraphs, bold, italic, code, fenced
// code, lists, quotes, rules, tables and links. Everything is escaped
// first; a link only keeps an http(s) or mailto address. No HTML passes
// through, so a doc can never carry a script.

export const DOC_SOURCE = 'source.md';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function safeHref(url: string): string | undefined {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : undefined;
}

// Inline marks on already-escaped text, code spans first so their insides
// stay literal.
export function inline(raw: string): string {
  const codes: string[] = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${esc(href)}">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(4, h[1]!.length + 1);
      out.push(`<h${level}>${inline(h[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.+)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[2]!);
        items.push(task ? `<li class="task${task[1] !== ' ' ? ' done' : ''}"><span class="box"></span>${inline(task[2]!)}</li>` : `<li>${inline(m[2]!)}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}

// The page palette (the Split hero look, Wayne, 10 Nov 2026), shared with
// the page-making skill's theme.css so a doc sits beside a dashboard as
// one set. Follows the viewer's light or dark appearance with no script.
export const PAGE_THEME_CSS = `:root{color-scheme:dark light;--bg:#0b0d10;--card:#12161b;--line:#20262e;--text:#e6e8eb;--dim:#7d8590;--teal:#4fb3d9;--slate:#5f7a94;--amber:#e8a33d;--amberline:#3a2e1a}
@media (prefers-color-scheme: light){:root{--bg:#f5f3ee;--card:#fbfaf7;--line:#e2ded5;--text:#1d1f22;--dim:#7a766e;--teal:#3d86a3;--slate:#97a8b8;--amber:#d39634;--amberline:#ecd6ad}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased}`;

const DOC_CSS = `main{max-width:760px;margin:0 auto;padding:28px 22px 40px}
header{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:18px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px;letter-spacing:-.01em}
.meta{color:var(--dim);font-size:12px}
h2{font-size:18px;margin:26px 0 8px}h3{font-size:15px;margin:20px 0 6px}h4{font-size:14px;margin:16px 0 4px;color:var(--dim)}
p{margin:0 0 12px}
a{color:var(--teal);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--teal) 40%,transparent)}
code{font:12.5px ui-monospace,"SF Mono",Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
pre code{border:0;padding:0;background:none}
ul,ol{margin:0 0 12px;padding-left:22px}li{margin:3px 0}
li.task{list-style:none;margin-left:-20px}
.box{display:inline-block;width:12px;height:12px;border:1.5px solid var(--dim);border-radius:3px;margin-right:8px;vertical-align:-1px}
li.task.done .box{background:var(--teal);border-color:var(--teal)}
li.task.done{color:var(--dim)}
blockquote{margin:0 0 12px;padding:2px 14px;border-left:3px solid var(--amber);color:var(--dim)}
hr{border:0;border-top:1px solid var(--line);margin:22px 0}
table{width:100%;border-collapse:collapse;margin:0 0 14px;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500}`;

export function renderDoc(title: string, md: string, meta: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_THEME_CSS}
${DOC_CSS}</style>
</head>
<body>
<main>
<header><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></header>
${markdownToHtml(md)}
</main>
</body>
</html>
`;
}
