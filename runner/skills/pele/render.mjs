#!/usr/bin/env node
// Renders a Mermaid file with Pele (https://pele.run) into a standalone
// HTML page (light and dark, for Threadbear's side panel or a browser) and
// an SVG next to it. Usage: node render.mjs diagram.mmd [--title "Title"]
// Prints the paths it wrote. Exits 1 with Pele's message if the diagram
// doesn't parse, so the agent can fix the source and run it again.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { render } from "pele";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const titleAt = args.indexOf("--title");
if (!file) {
  console.error("usage: node render.mjs diagram.mmd [--title \"Title\"]");
  process.exit(2);
}
const path = resolve(file);
const source = readFileSync(path, "utf8");
const name = basename(path, extname(path));
const title = titleAt >= 0 ? args[titleAt + 1] : name.replace(/[-_]+/g, " ");

let result;
try {
  result = render(source);
} catch (error) {
  console.error(`Pele couldn't render ${file}: ${error.message}`);
  process.exit(1);
}

const light = `--pele-bg:#ffffff;--pele-fg:#1d1d1f;--pele-muted:#6e6e73;--pele-line:#3a3a3c;--pele-surface:#f2f2f7;--pele-surface-alt:#e5e5ea;--pele-border:#c7c7cc;--pele-accent:#0a84ff;--pele-font:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;--pele-radius:6px;`;
const dark = `--pele-bg:#1e1e1e;--pele-fg:#f2f2f7;--pele-muted:#a1a1a6;--pele-line:#d1d1d6;--pele-surface:#2c2c2e;--pele-surface-alt:#3a3a3c;--pele-border:#48484a;--pele-accent:#0a84ff;`;
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { ${light} color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { ${dark} } }
  body { margin: 0; padding: 32px; background: var(--pele-bg); color: var(--pele-fg); font-family: var(--pele-font); }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 20px; }
  .diagram { display: flex; justify-content: center; }
  .diagram svg { max-width: 100%; height: auto; }
  details { margin-top: 28px; color: var(--pele-muted); font-size: 13px; }
  pre { background: var(--pele-surface); padding: 12px; border-radius: 6px; overflow: auto; color: var(--pele-fg); }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<div class="diagram">${result.svg}</div>
<details><summary>Mermaid source</summary><pre>${escape(source)}</pre></details>
</body>
</html>
`;

// The SVG on its own carries the light colours, so it shows anywhere.
const svg = result.svg.replace(/^<svg([^>]*)>/, `<svg$1><style>svg{${light}}</style>`);

const out = dirname(path);
const htmlPath = join(out, `${name}.html`);
const svgPath = join(out, `${name}.svg`);
writeFileSync(htmlPath, html);
writeFileSync(svgPath, svg);
console.log(`${result.mermaidType ?? result.type} diagram, ${Math.round(result.width)}×${Math.round(result.height)}`);
console.log(htmlPath);
console.log(svgPath);
