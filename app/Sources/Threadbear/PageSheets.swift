import AppKit
import SwiftUI
import ThreadbearCore

/// A page card's ⋯ menu in a reply (PageCardCell), and the sheets it opens
/// over the main window: the same items and sheets as a project's Pages.
@MainActor
enum PageMenuBuilder {
    static func menu(for page: Page, app: AppModel) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(ClosureItem("Open") { app.openPage(page) })
        menu.addItem(ClosureItem("Refresh") { app.refreshPage(page) })
        menu.addItem(ClosureItem("Edit with Agent…") {
            PageSheets.present { close in AskPageSheet(page: page, close: close) }
        })
        if page.hasEditableSource {
            menu.addItem(ClosureItem("Edit Text…") {
                PageSheets.present { close in EditDocSheet(page: page, close: close) }
            })
        }
        menu.addItem(.separator())
        menu.addItem(ClosureItem("Download…") { app.downloadPage(page) })
        menu.addItem(ClosureItem("Download as PDF…") { app.downloadPagePDF(page) })
        let versions = NSMenuItem(title: "Versions", symbol: "clock.arrow.circlepath", action: nil)
        let sub = NSMenu()
        for v in page.keptVersions {
            if v == page.version {
                sub.addItem(ClosureItem("Open Version \(v) (newest)") { app.openPage(page, version: v) })
            } else {
                let item = NSMenuItem(title: "Version \(v)", symbol: "doc", action: nil)
                let inner = NSMenu()
                inner.addItem(ClosureItem("Open") { app.openPage(page, version: v) })
                inner.addItem(ClosureItem("Make This the Newest") { app.restorePageVersion(page, version: v) })
                inner.addItem(ClosureItem("Download…") { app.downloadPage(page, version: v) })
                inner.addItem(ClosureItem("Download as PDF…") { app.downloadPagePDF(page, version: v) })
                item.submenu = inner
                sub.addItem(item)
            }
        }
        versions.submenu = sub
        menu.addItem(versions)
        menu.addItem(.separator())
        if page.publishedSlug != nil {
            menu.addItem(ClosureItem("Copy Link") { app.copyPrintLink(page) })
            if let link = app.printLink(page) { menu.addItem(ClosureItem("Open on the Web") { OpenGate.openWeb(link) }) }
            menu.addItem(ClosureItem("Unpublish") { app.unpublishPage(page) })
        } else if !page.live {
            menu.addItem(ClosureItem("Publish…") { app.publishPage(page) })
        }
        menu.addItem(.separator())
        menu.addItem(ClosureItem("Delete") { app.deletePage(page) })
        return menu
    }
}

/// A menu item that runs a closure.
final class ClosureItem: NSMenuItem {
    private let run: () -> Void

    init(_ title: String, run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func fire() { run() }
}

@MainActor
enum PageSheets {
    /// A sheet over the main window, closed by the view's `close`.
    static func present<V: View>(_ make: (@escaping () -> Void) -> V) {
        guard let parent = NSApp.mainWindow ?? NSApp.keyWindow else { return }
        let sheet = NSWindow(contentRect: .zero, styleMask: [.titled], backing: .buffered, defer: true)
        let close = { [weak parent, weak sheet] in
            guard let parent, let sheet else { return }
            parent.endSheet(sheet)
        }
        sheet.contentViewController = NSHostingController(rootView: make(close).environment(AppModel.shared))
        parent.beginSheet(sheet)
    }
}
