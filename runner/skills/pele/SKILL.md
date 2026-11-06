---
name: pele
description: Draw Mermaid diagrams with Pele, which renders Mermaid text to a clean SVG and an HTML page. Use this whenever someone asks for a Mermaid diagram or any chart-like diagram that Mermaid can express - flowchart, sequence diagram, class, state, ER or database schema, Gantt or timeline, user journey, mind map, pie, quadrant, git graph, architecture or C4, sankey, XY chart, kanban - including "diagram this flow", "draw the architecture", "show the schema", "make a chart of". When it's unclear whether a diagram or a machine illustration is wanted, use this. Not for illustrations of how a physical machine or mechanism works (an engine, a lock, a watch, an isometric explainer): the anatomy skill is for those.
license: MIT
---

# Pele: Mermaid diagrams

Pele (https://pele.run, MIT, by Obsidian) renders every Mermaid 12.1.0 diagram
type to SVG with its own clean layout. It's installed in this skill's folder
(`node_modules/pele`), so nothing is downloaded and nothing leaves the Mac.

## Making a diagram

1. Write the Mermaid source to a `.mmd` file where the work belongs: the
   project's `docs/`, or the thread's folder for a one-off. Name it for what
   it shows (`checkout-flow.mmd`).
2. Render it with the script in this skill's folder (the base directory you
   were given for this skill):

   ```sh
   node "<this skill's folder>/render.mjs" path/to/checkout-flow.mmd --title "Checkout flow"
   ```

   It writes `checkout-flow.html` (light and dark, with the source folded
   under it) and `checkout-flow.svg` next to the `.mmd`, and prints their
   paths. If Pele can't parse the source it exits 1 with the reason: fix the
   Mermaid and run it again.
3. Show it. In Threadbear, pin the HTML page with `show: true` so it opens in
   the side panel beside the thread. Elsewhere, give the path to the HTML (or
   the SVG for docs).
4. In your reply, say in a sentence what the diagram shows. Put the Mermaid
   source in a ```mermaid block only if they asked for the source, or it's
   going into a README or docs that draw Mermaid themselves (GitHub does).

## Tips

- Keep labels short; put detail in the reply, not the boxes.
- `flowchart LR` reads well for pipelines, `TD` for hierarchies.
- To change a diagram, edit the `.mmd` and render again; the page updates in place.
