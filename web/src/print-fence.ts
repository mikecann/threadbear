// A reply's ```print <id>``` (or the old ```page <id>```) block, as the Mac
// reads it (PageFence in app/Sources/ThreadbearCore/Markdown/RichBlock.swift):
// the id in the info string, or as the block's first word. react-markdown
// drops the info string after the language, so this reads the block's source.

export function isPrintId(s: string): boolean {
  return s.length > 3 && s.length <= 80 && /^pg_[a-z0-9_]+$/.test(s);
}

// The id in a fenced block's source (its opening line through its close), or
// undefined for any other block.
export function printFenceId(source: string): string | undefined {
  const lines = source.split('\n');
  const open = /^\s*(`{3,}|~{3,})\s*(\S+)?\s*(\S+)?/.exec(lines[0] ?? '');
  if (!open || !open[2] || !['print', 'page'].includes(open[2].toLowerCase())) return undefined;
  const candidate = open[3] ?? lines.slice(1).join('\n').replace(/(`{3,}|~{3,})\s*$/, '').trim().split(/\s+/)[0] ?? '';
  return isPrintId(candidate) ? candidate : undefined;
}

// What a card says about one, from the published list (prints:list).
export type PublishedPrint = { id: string; slug: string; title: string; kind: string; version: number; summary: string };

export function printLabel(kind: string): string {
  return kind === 'page' ? 'Print' : kind.charAt(0).toUpperCase() + kind.slice(1);
}
