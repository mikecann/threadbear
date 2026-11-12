import AppKit
import UniformTypeIdentifiers
import ThreadbearCore

/// Pages (docs/protocol.md, "Pages"): the pages agents make, kept by the
/// runner, listed on each project's page with a menu for each: Open,
/// Refresh, Edit with Agent, Edit Text (docs), Download, Versions, Move to
/// Project and Delete. The pages experiment.
extension AppModel {
    var pagesOn: Bool { experiments.contains(Page.experiment) }

    /// The rail's Prints button: Prints on, at least one Print, and a
    /// thread of this runner's (another Mac's Prints aren't here).
    var showsPrintsRail: Bool {
        pagesOn && openProject == nil && paneThread?.isRemote != true && !PrintRows.all(pages).isEmpty
    }

    /// The list after hello; `pages.updated` keeps it current from then on.
    func loadPages() {
        guard let client, pagesOn else {
            pages = []
            return
        }
        Task {
            do {
                pages = try await client.listPages()
            } catch {
                // An older runner, or the experiment just turned off.
                pages = []
                AppLog.write("rpc", "pages.list failed: \(error.localizedDescription)")
            }
        }
    }

    /// Deleted ones aren't in `pages.updated`: asked for when a project's
    /// Recently Deleted is shown, and after a delete or restore.
    func loadDeletedPages() {
        guard let client, pagesOn else { return }
        Task { deletedPages = (try? await client.listPages(deleted: true)) ?? [] }
    }

    func pages(in projectId: String) -> [Page] {
        pages.filter { $0.isIn(project: projectId) }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func deletedPages(in projectId: String) -> [Page] {
        deletedPages.filter { $0.isIn(project: projectId) }
    }

    /// Opens a version (the newest by default) in a window of its own, the
    /// way a reply's page opens: sandboxed, scripts off until Run them.
    func openPage(_ page: Page, version: Int? = nil) {
        guard let client else { return }
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                let got = try await client.getPage(page.id, version: version)
                let v = version ?? got.page.version
                RichBlockWindowController.show(URL(fileURLWithPath: got.file), id: "page:\(page.id):\(v)", title: got.page.title, subtitle: v == got.page.version ? "Version \(v)" : "Version \(v) of \(got.page.version)")
            } catch {
                show(error)
            }
        }
    }

    /// From a reply's card: in this thread's side pane, as a highlight
    /// opens, where it follows new versions. A thread on another runner, or
    /// none selected, gets the window instead (its file is on that Mac).
    func openPageHere(_ page: Page) {
        guard let client, let thread = selectedThread, !thread.isRemote else { return openPage(page) }
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                let got = try await client.getPage(page.id)
                preview(path: got.file, title: got.page.title, in: thread)
            } catch {
                show(error)
            }
        }
    }

    /// A side pane showing a Print's newest version moves to the new one
    /// when it lands, rather than staying on the file it opened.
    func followPageVersions(before: [Page]) {
        for (threadId, shown) in panePreview {
            guard let path = shown.fileURL?.path,
                  let next = PagePath.newer(than: path, before: before, after: pages),
                  FileManager.default.fileExists(atPath: next) else { continue }
            var moved = shown
            moved.target = .file(next)
            show(moved, in: threadId)
        }
    }

    /// Sends the page to the thread that made it to be made again from its
    /// recipe, and opens that thread so its work can be watched.
    func refreshPage(_ page: Page) {
        guard let client else { return }
        PageCards.shared.markRefreshing(page)
        whileBusy(BusyKey.page(page.id), note: "Asking a thread to refresh \(page.title)") { [self] in
            do {
                let sent = try await client.refreshPage(page.id)
                openThread(sent.threadId)
            } catch {
                show(error)
            }
        }
    }

    func editPageWithAgent(_ page: Page, text: String) {
        guard let client, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        PageCards.shared.markRefreshing(page)
        whileBusy(BusyKey.page(page.id), note: "Asking a thread to change \(page.title)") { [self] in
            do {
                let sent = try await client.editPageWithAgent(page.id, text: text)
                openThread(sent.threadId)
            } catch {
                show(error)
            }
        }
    }

    /// Source for the shared text editor; older runners may have no source.
    func pageMarkdown(_ page: Page) async -> String? {
        guard let client else { return nil }
        do {
            let got = try await client.getPage(page.id)
            guard let source = page.isDiagram ? got.mermaid : got.markdown else {
                showError("This print has no editable source. Ask its thread to rebuild it.", in: page.ownerThread, doing: "Opening the Print editor")
                return nil
            }
            return source
        } catch {
            show(error)
            return nil
        }
    }

    /// Saves the user's edit as a new version; `done` runs once it's in.
    func savePageDoc(_ page: Page, markdown: String, done: @escaping @MainActor (Bool) -> Void) {
        guard let client else { return done(false) }
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                let saved = page.isDiagram
                    ? try await client.savePageDiagram(page.id, mermaid: markdown)
                    : try await client.savePageDoc(page.id, markdown: markdown)
                replace(page: saved)
                done(true)
            } catch {
                show(error)
                done(false)
            }
        }
    }

    func restorePageVersion(_ page: Page, version: Int) {
        guard let client else { return }
        whileBusy(BusyKey.page(page.id), note: "Restoring version \(version) of \(page.title)") { [self] in
            do {
                replace(page: try await client.restorePageVersion(page.id, version: version))
            } catch {
                show(error)
            }
        }
    }

    /// Takes the row away at once; the runner keeps it 7 days.
    func deletePage(_ page: Page) {
        guard let client else { return }
        let before = pages
        pages.removeAll { $0.id == page.id }
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                let gone = try await client.deletePage(page.id)
                deletedPages.removeAll { $0.id == gone.id }
                deletedPages.insert(gone, at: 0)
            } catch {
                pages = before
                show(error)
            }
        }
    }

    func restorePage(_ page: Page) {
        guard let client else { return }
        deletedPages.removeAll { $0.id == page.id }
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                replace(page: try await client.restorePage(page.id))
            } catch {
                loadDeletedPages()
                show(error)
            }
        }
    }

    /// Puts the page in or out of a project, showing the change at once.
    func togglePage(_ page: Page, inProject projectId: String) {
        guard let client else { return }
        let adding = !page.isIn(project: projectId)
        whileBusy(BusyKey.page(page.id)) { [self] in
            do {
                replace(page: try await client.setPageProjects(page.id, add: adding ? [projectId] : [], remove: adding ? [] : [projectId]))
            } catch {
                show(error)
            }
        }
    }

    /// Asks where, copies the page's files into a new folder named for it
    /// there, and shows it in the Finder.
    func downloadPage(_ page: Page, version: Int? = nil) {
        guard let client else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Save Here"
        panel.message = "Choose where to save \"\(page.title)\". It goes in a new folder with its index.html, which opens in any browser."
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        let name = page.title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        var dest = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) {
            dest = folder.appendingPathComponent("\(name) \(n)")
            n += 1
        }
        let target = dest
        whileBusy(BusyKey.page(page.id), note: "Saving \(page.title)") { [self] in
            do {
                let file = try await client.exportPage(page.id, to: target.path, version: version)
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: file)])
            } catch {
                show(error)
            }
        }
    }

    /// Asks where, draws the page (or a version) as a US Letter PDF in the
    /// light look, saves it, and shows it in the Finder.
    func downloadPagePDF(_ page: Page, version: Int? = nil) {
        guard let client else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.canCreateDirectories = true
        let name = page.title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        panel.nameFieldStringValue = version.map { "\(name) v\($0).pdf" } ?? "\(name).pdf"
        panel.message = "Save \"\(page.title)\" as a PDF."
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        whileBusy(BusyKey.page(page.id), note: "Saving \(page.title) as a PDF") { [self] in
            do {
                let got = try await client.getPage(page.id, version: version)
                let pdf = try await RichRenderer.shared.pagePDF(file: got.file)
                try pdf.write(to: dest, options: .atomic)
                NSWorkspace.shared.activateFileViewerSelecting([dest])
            } catch {
                show(error)
            }
        }
    }

    /// A published print's link on the website, while sync is on.
    func printLink(_ page: Page) -> URL? {
        guard let slug = page.publishedSlug else { return nil }
        return websiteURL?.appendingPathComponent("p").appendingPathComponent(slug)
    }

    /// Asks first (anyone with the link can open it), then sends the print
    /// to the Convex backend and copies its link.
    func publishPage(_ page: Page) {
        guard let client else { return }
        let alert = NSAlert()
        alert.messageText = "Publish \u{201C}\(page.title)\u{201D}?"
        alert.informativeText = "It goes to your Convex backend, so it opens on your phone and the website, and anyone with its link can open it. New versions go up by themselves. Unpublish takes it down."
        alert.addButton(withTitle: "Publish")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        whileBusy(BusyKey.page(page.id), note: "Publishing \(page.title)") { [self] in
            do {
                let got = try await client.publishPage(page.id)
                replace(page: got.page)
                if let link = got.url ?? printLink(got.page)?.absoluteString {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(link, forType: .string)
                }
            } catch {
                show(error)
            }
        }
    }

    func unpublishPage(_ page: Page) {
        guard let client else { return }
        whileBusy(BusyKey.page(page.id), note: "Unpublishing \(page.title)") { [self] in
            do {
                replace(page: try await client.unpublishPage(page.id))
            } catch {
                show(error)
            }
        }
    }

    func copyPrintLink(_ page: Page) {
        guard let link = printLink(page) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link.absoluteString, forType: .string)
    }

    private func replace(page: Page) {
        if let i = pages.firstIndex(where: { $0.id == page.id }) { pages[i] = page } else if page.deletedAt == nil { pages.insert(page, at: 0) }
    }
}
