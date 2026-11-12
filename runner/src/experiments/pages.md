---
id: pages
name: Prints
title: Prints: charts, dashboards, reports and docs a thread keeps for you
added: 2026-11-10
on: false
reminder: ee0c4ba6
---

## What it does

Diagram Prints take Mermaid source and draw static SVG offline with Pele. Edit Text edits their source and saves a new version; Download includes the Mermaid and SVG. A malformed edit leaves the previous version unchanged. Published diagrams include their source.

Lets a thread's agent make a Print you keep (called Pages until 10 Nov 2026): a chart, a dashboard, a report or a doc, from a data file you give it, a project's files, or a command's output. Asking again updates the same page to a new version instead of posting another, and the last 10 versions are kept. A page belongs to the thread that made it and can be in any of your projects, or none: a thread pinned to one project puts its pages there by itself. In a reply, a print shows as a card with a picture of it that follows its newest version. Each project's page lists its prints under Prints: click one to open it, and use its menu to Refresh it, Edit with Agent, edit a doc's text yourself, Download it (as files or as a PDF), open or restore an older version, move it between projects, or Delete it (kept 7 days under Recently deleted). Prints are HTML, CSS and pictures with no scripts, unless an agent makes a live one, whose scripts run only after you choose Run them. They're kept on your Mac, in the pages folder in Threadbear's data folder. Nothing about a print goes to Convex unless you choose Publish on it: then its page goes to your own Convex backend, opens on your phone, the website and for anyone with its link, follows new versions, and comes down when you unpublish or delete it. The guide's Prints section lists what to say.

## Lives in

Only make Prints when I ask is a normal setting, `printsWhenAsked` in runner.json (`config.ts`, `settings.ts`), checked in `create_print` in `runner/src/threadbear-mcp.ts` (`asksForPrint`), with its switch in the app's `SettingsView.swift`.

Diagram rendering is in `runner/src/page-diagram.ts`, using the pinned Pele bundle and its MIT license in `runner/skills/pele/` (shipped in releases: `skills` is in `RELEASE_PATHS`). The app reuses Edit Text; `Page.swift` and `RunnerAPI.swift` add diagram source and `pages.saveDiagram`.

`runner/src/pages.ts` (the store, `<home>/pages/`) and `runner/src/page-doc.ts` (docs); the page tools (`create_print`, `update_print`, `list_prints`, `read_print`, `delete_print`, `restore_print`, `export_print`, `add_print_to_project`, `remove_print_from_project`, and their old `page` names) in `buildThreadbearTools` (`runner/src/threadbear-mcp.ts`), with `list_prints` and `read_print` (and the old names) in `NEVER_ASK_TOOLS`; `pagesFor` and `pageMethods` (`pages.*` and `pages.updated`) and `askAboutPage` (Refresh and Edit with agent) in `runner/src/main.ts`; in the app, `ThreadbearCore/Protocol/Page.swift`, `Threadbear/Pages.swift` and `PagesSection` in `Views/ProjectPage.swift`; the card in replies, `Transcript/PageCards.swift` (`PageCardCell`), `PageSheets.swift`, `ThreadbearCore/Support/PagePDF.swift` and `pagePDF` in `RichRenderer.swift` (Download as PDF), `PageFence` in `ThreadbearCore/Markdown/RichBlock.swift` and `drawPageCard` in `Transcript/RichRenderer.swift`

## Taking it out

For Only make Prints when I ask, also remove `printsWhenAsked` from `config.ts`, `settings.ts`, `cli.ts`, `main.ts`, `RunnerSettings.swift`, `RunnerSettingsModel.swift`, `Automation.swift` and its Settings section, and `asksForPrint` with its check in `create_print`.

For diagrams, also remove `runner/src/page-diagram.ts`, `runner/test/unit/page-diagram.test.ts`, the copied `runner/skills/pele/pele.js` and its license (and `skills` from `RELEASE_PATHS` in `update.ts` and `deploy.mjs`), the Mermaid fields and save method in Pages and the app.

For publishing, also take out `convex/prints.ts`, the `prints` table in `convex/schema.ts`, `publishPrint` and `unpublishPrint` in `convex/sync.ts` and `convex/runnerAccess.ts`, `web/src/print.tsx`, `print-doc.ts` and the `/p/` route in `web/src/route.ts`; unpublish every print first, or their rows stay in the backend. Delete `runner/src/pages.ts`, `runner/src/page-doc.ts` and its test, the page tools, their `pages` option and their names in `NEVER_ASK_TOOLS` in `threadbear-mcp.ts`, `pagesFor`, `pageMethods` and `askAboutPage` in `main.ts`, and the `pages.updated` notification in `runner.ts`. In the app, delete `Page.swift`, `Pages.swift`, `PageTests.swift`, `PagesSection`, `PageRow`, `PageMenu`, `AskPageSheet` and `EditDocSheet` in `ProjectPage.swift`, `pages`, `deletedPages` and `pagesUpdated` in `AppModel`, `RPCClient` and `RunnerAPI`, and `BusyKey.page`. the `Prints` section of `docs/guide.md`. Saved pages are the `pages` folder in Threadbear's data folder.
