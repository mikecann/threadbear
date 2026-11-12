// Diagram Prints reuse the app's pinned, offline Pele bundle. Only the
// library runs as code; Mermaid is passed as data into a fresh context.
import fs from 'node:fs';
import vm from 'node:vm';
import { PAGE_THEME_CSS } from './page-doc.ts';

export const DIAGRAM_SOURCE = 'source.mmd';
export const DIAGRAM_SOURCE_MAX = 20_000;
const RENDER_MS = 1_500;
const SVG_MAX = 800_000;
let library: vm.Script | undefined;
const draw = new vm.Script('pele.render(source)', { filename: 'print-diagram-render' });
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Reject active SVG and external references even if a future renderer
// starts emitting them. Diagrams are always passive, including published ones.
export function passiveDiagramSvg(svg: string): boolean {
  if (!/^<svg\b/.test(svg) || svg.length > SVG_MAX) return false;
  if (/<\s*(?:script|foreignObject|iframe|object|embed|image|feImage|audio|video|set|discard|animate\w*)\b|\son[\w:-]*\s*=|<!ENTITY|<!DOCTYPE/i.test(svg)) return false;
  if (/\b(?:href|src)\s*=\s*(?!["']#)["']|\b(?:href|src)\s*=\s*[^\s"']/i.test(svg)) return false;
  if (/url\(\s*["']?(?!#)[^\s"')]|@import|javascript\s*:/i.test(svg)) return false;
  // Escaped CSS can conceal url() and imports; the pinned renderer needs
  // neither escapes nor character references in its style declarations.
  const styles = [...svg.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)].map((m) => m[2]!);
  styles.push(...[...svg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]!));
  if (styles.some((style) => /\\|&#|@/i.test(style))) return false;
  return true;
}

const PALETTE = `--pele-bg:var(--bg);--pele-fg:var(--text);--pele-muted:var(--dim);--pele-line:var(--text);--pele-surface:var(--card);--pele-surface-alt:var(--line);--pele-border:var(--slate);--pele-accent:var(--teal);--pele-font:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;--pele-radius:6px`;

// The page's own width. A diagram wider than this gets the whole window and
// is never drawn below MIN_SCALE of its size, where labels stay about 11px;
// past that it scrolls sideways.
const WIDE_DIAGRAM = 1150;
const MIN_SCALE = 0.7;

export function renderDiagram(title: string, source: string, meta: string): { html: string; svg: string } {
  if (!source.trim()) throw new Error('The diagram has no Mermaid source.');
  if (source.length > DIAGRAM_SOURCE_MAX) throw new Error('A diagram can have at most 20,000 source characters.');
  try {
    library ??= new vm.Script(fs.readFileSync(new URL('../skills/pele/pele.js', import.meta.url), 'utf8'), { filename: 'pele.js' });
    const context = vm.createContext({ source }, { codeGeneration: { strings: false, wasm: false } });
    library.runInContext(context, { timeout: RENDER_MS });
    const result: unknown = draw.runInContext(context, { timeout: RENDER_MS });
    if (!result || typeof result !== 'object' || !('svg' in result) || typeof result.svg !== 'string' || !passiveDiagramSvg(result.svg)) {
      throw new Error('The diagram renderer returned unsupported SVG.');
    }
    const svg = result.svg.replace(/^(<svg\b[^>]*>)/, `$1<style>${PAGE_THEME_CSS}svg{${PALETTE}}</style>`);
    // Shrunk to fit, a wide flowchart's labels end up too small to read
    // (a 3,442px one at a third of its size, 12 Nov). Printed, it still fits
    // the page.
    const natural = Number(/<svg\b[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(result.svg)?.[1]);
    const wide = Number.isFinite(natural) && natural > WIDE_DIAGRAM
      ? `.diagram{overflow-x:auto;width:calc(100vw - 44px);margin-left:calc(50% - 50vw + 22px)}.diagram svg{max-width:none!important;width:max(100%, ${Math.ceil(natural * MIN_SCALE)}px)!important;height:auto;margin:0}@media print{.diagram{width:auto;margin-left:0}.diagram svg{max-width:100%!important;width:auto!important}}`
      : '';
    return {
      svg,
      html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_THEME_CSS}
main{padding:28px 22px;max-width:1200px;margin:auto}h1{font-size:24px;line-height:1.25;margin:0 0 4px}.meta{font-size:12px;color:var(--dim)}.diagram{margin:24px 0;overflow:auto;${PALETTE}}.diagram svg{display:block;max-width:100%;height:auto;margin:auto}details{margin-top:20px}summary{cursor:pointer;color:var(--dim)}pre{padding:12px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap}@media print{details{display:none}.diagram{overflow:visible}}${wide}</style></head><body><main><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div><div class="diagram">${result.svg}</div><details><summary>Mermaid source</summary><pre>${esc(source)}</pre></details></main></body></html>`,
    };
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message).slice(0, 300) : 'invalid source';
    throw new Error(`Could not render the diagram: ${message}`);
  }
}
