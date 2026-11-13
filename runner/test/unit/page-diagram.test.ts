import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { passiveDiagramSvg, renderDiagram } from '../../src/page-diagram.ts';

test('diagram SVG refuses active elements, events, external references and CSS imports', () => {
  assert.equal(passiveDiagramSvg('<svg><path marker-end="url(#arrow)"/><use href="#node"/></svg>'), true);
  for (const svg of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><foreignObject>html</foreignObject></svg>',
    '<svg><image href="https://example.org/track"/></svg>',
    '<svg><a href="https://example.org">go</a></svg>',
    '<svg><use href=external.svg/></svg>',
    '<svg><style>@import "https://example.org/a.css";</style></svg>',
    '<svg><path style="fill:url(https://example.org/a.svg)"/></svg>',
    '<svg><a id="t"><rect/></a><set href="#t" attributeName="href" to="https://example.org"/></svg>',
    '<svg><style>path{fill:u\\72l(https://example.org/a.svg)}</style></svg>',
    '<svg><path style="fill:u&#92;72l(https://example.org/a.svg)"/></svg>',
  ]) assert.equal(passiveDiagramSvg(svg), false, svg);
});

test('diagram renderer is the app bundle, with source passed as text and theme-aware export', () => {
  assert.equal(
    fs.readFileSync(new URL('../../skills/pele/pele.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../../app/Sources/Threadbear/Resources/Rich/pele.js', import.meta.url), 'utf8'),
  );
  const diagram = renderDiagram('<Flow>', 'flowchart LR\n A["process.exit(1)"] --> B[Done]', 'Version 1');
  assert.match(diagram.html, /&lt;Flow&gt;/);
  assert.match(diagram.html, /process.exit\(1\)/);
  assert.match(diagram.svg, /prefers-color-scheme/);
  assert.doesNotMatch(diagram.html, /<script\b/i);
  assert.throws(() => renderDiagram('Empty', '', ''), /no Mermaid source/);
  assert.throws(() => renderDiagram('Large', 'x'.repeat(20_001), ''), /20,000/);
});

// Wayne, 12 Nov: a 3,442px-wide flowchart was shrunk to fit 1,150px, so its
// labels came out at a third of their size and couldn't be read.
test('a wide diagram keeps its labels readable: the whole window, never below 70% of its size, fitted only when printed', () => {
  const nodes = Array.from({ length: 16 }, (_, i) => `N${i}["Step number ${i} with a long label"]`).join(' --> ');
  const wide = renderDiagram('Wide', `flowchart LR\n ${nodes}`, 'Version 1');
  const width = Number(/<svg\b[^>]*\bwidth="(\d+(?:\.\d+)?)"/.exec(wide.svg)?.[1]);
  assert.ok(width > 1200, `the test diagram is wide (${width}px)`);
  assert.match(wide.html, new RegExp(`\\.diagram svg\\{[^}]*max-width:none!important;width:max\\(100%, ${Math.ceil(width * 0.7)}px\\)!important`));
  assert.match(wide.html, /\.diagram\{[^}]*width:calc\(100vw - 44px\)/, 'it gets the whole window');
  assert.match(wide.html, /\.diagram\{[^}]*overflow-x:auto/);
  assert.match(wide.html, /@media print\{[^}]*\}?[^@]*\.diagram svg\{max-width:100%!important;width:auto!important/);
  const small = renderDiagram('Small', 'flowchart LR\n A --> B', 'Version 1');
  assert.doesNotMatch(small.html, /max-width:none!important/, 'a small one still fits the page');
});
