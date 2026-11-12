import AppKit
import Synchronization
import ThreadbearCore

/// What a ```print card in a reply (```page before the rename to Prints)
/// needs to know (the pages experiment,
/// "Preview on top", Wayne picked it on 10 Nov 2026): each page as it is
/// now, where its newest file is, and which are being refreshed. Read from
/// any thread, as rows render across cores; written on the main thread
/// from AppModel's pages. A change renders the rows holding cards again
/// (RichBlocks.bump), so a card always shows the newest version.
final class PageCards: @unchecked Sendable {
    static let shared = PageCards()

    private struct Inner {
        var enabled = false
        var pages: [String: Page] = [:]
        /// The newest file, per page, for the version it was asked for.
        var files: [String: (version: Int, file: String)] = [:]
        var asking: Set<String> = []
        /// Refresh or Edit with Agent sent at this version; cleared once a
        /// newer version lands, or after `refreshFor`.
        var refreshing: [String: (version: Int, since: Date)] = [:]
    }

    private let inner = Mutex(Inner())
    static let refreshFor: TimeInterval = 20 * 60

    var enabled: Bool { inner.withLock { $0.enabled } }
    func page(_ id: String) -> Page? { inner.withLock { $0.pages[id] } }

    func isRefreshing(_ id: String, now: Date = Date()) -> Bool {
        inner.withLock { inner in
            guard let r = inner.refreshing[id], let page = inner.pages[id] else { return false }
            return page.version <= r.version && now.timeIntervalSince(r.since) < Self.refreshFor
        }
    }

    @MainActor
    func update(_ pages: [Page], enabled: Bool) {
        inner.withLock { inner in
            inner.enabled = enabled
            inner.pages = Dictionary(pages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for (id, r) in inner.refreshing where (inner.pages[id]?.version ?? 0) > r.version { inner.refreshing[id] = nil }
        }
        RichBlocks.shared.bump()
    }

    @MainActor
    func markRefreshing(_ page: Page) {
        inner.withLock { $0.refreshing[page.id] = (page.version, Date()) }
        RichBlocks.shared.bump()
    }

    /// The block that draws the page's newest file, or nil while its path
    /// is being asked for (then the rows render again when it comes).
    func thumb(_ page: Page) -> RichBlock? {
        let known = inner.withLock { inner -> (version: Int, file: String)? in inner.files[page.id] }
        if let known, known.version == page.version { return RichBlock.pageThumb(file: known.file, version: known.version, nativeDiagram: page.isDiagram) }
        let ask = inner.withLock { inner -> Bool in
            guard !inner.asking.contains(page.id) else { return false }
            inner.asking.insert(page.id)
            return true
        }
        if ask {
            Task { @MainActor in
                defer { _ = self.inner.withLock { $0.asking.remove(page.id) } }
                guard let client = AppModel.shared.client, let got = try? await client.getPage(page.id) else { return }
                self.inner.withLock { $0.files[page.id] = (got.page.version, got.file) }
                RichBlocks.shared.bump()
            }
        }
        return nil
    }
}

/// The card for a ```page block: the top of the page as a picture,
/// with its kind, title, version and age under it, and Open, Refresh
/// and a menu. Clicking the picture opens it too. Everything it shows is
/// fixed when the row renders; a change renders the row again.
final class PageCardCell: NSTextAttachmentCell {
    enum Action: String, CaseIterable {
        case open, refresh, more, preview

        var tip: String {
            switch self {
            case .open: return "Open this print in a window of its own"
            case .refresh: return "Ask the thread that made it to make it again the same way"
            case .more: return "Edit with Agent, edit its text, download, versions or delete"
            case .preview: return "Open this print"
            }
        }
    }

    let pageId: String
    let page: Page?
    let thumb: RichBlock?
    let thumbState: RichBlocks.State?
    let refreshing: Bool
    let now: Date

    init(pageId: String) {
        self.pageId = pageId
        page = PageCards.shared.page(pageId)
        thumb = page.flatMap { PageCards.shared.thumb($0) }
        thumbState = thumb.map { RichBlocks.shared.state($0) }
        refreshing = PageCards.shared.isRefreshing(pageId)
        now = Date()
        super.init()
    }

    required init(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static var previewHeight: CGFloat { zoomed(170) }
    static var footerHeight: CGFloat { zoomed(56) }
    static var pad: CGFloat { zoomed(12) }
    static var radius: CGFloat { zoomed(10) }
    private static var titleFont: NSFont { .systemFont(ofSize: TypeScale.label, weight: .semibold) }
    private static var metaFont: NSFont { .systemFont(ofSize: TypeScale.detail) }
    private static var buttonFont: NSFont { .systemFont(ofSize: TypeScale.detail, weight: .medium) }

    /// "Dashboard · v3 · 2h ago", or what's under way.
    var meta: String {
        guard let page else { return "Not on this Mac. It may be deleted, or on another Mac's runner." }
        if refreshing { return "\(page.kindLabel) · v\(page.version) · refreshing in its thread…" }
        let age = now.timeIntervalSince(page.updatedAt) < 90 ? "just now" : "\(RelativeTime.short(page.updatedAt, now: now)) ago"
        return "\(page.kindLabel) · v\(page.version) · \(age)\(page.publishedSlug != nil ? " · published" : "")"
    }

    /// A version newer than the first, made in the last 15 minutes.
    var isNewVersion: Bool {
        guard let page, !refreshing else { return false }
        return page.version > 1 && now.timeIntervalSince(page.updatedAt) < 15 * 60
    }

    override func cellFrame(for textContainer: NSTextContainer, proposedLineFragment lineFrag: NSRect, glyphPosition position: NSPoint, characterIndex charIndex: Int) -> NSRect {
        let width = max(zoomed(260), floor(lineFrag.width - position.x))
        return NSRect(x: 0, y: 0, width: width, height: (page == nil ? 0 : Self.previewHeight) + Self.footerHeight)
    }

    override func cellSize() -> NSSize { NSSize(width: zoomed(600), height: Self.previewHeight + Self.footerHeight) }
    override func cellBaselineOffset() -> NSPoint { .zero }
    override func wantsToTrackMouse() -> Bool { false }

    struct Layout {
        var box: NSRect
        var preview: NSRect
        var footer: NSRect
        var glyph: NSRect
        var buttons: [Action: NSRect]
    }

    func layout(in frame: NSRect) -> Layout {
        let box = frame.insetBy(dx: 0.5, dy: 0.5)
        let previewHeight = page == nil ? 0 : Self.previewHeight
        let preview = NSRect(x: box.minX, y: box.minY, width: box.width, height: previewHeight)
        let footer = NSRect(x: box.minX, y: preview.maxY, width: box.width, height: box.maxY - preview.maxY)
        let glyphSize = zoomed(30)
        let glyph = NSRect(x: footer.minX + Self.pad, y: footer.midY - glyphSize / 2, width: glyphSize, height: glyphSize)
        var buttons: [Action: NSRect] = [:]
        guard page != nil else { return Layout(box: box, preview: preview, footer: footer, glyph: glyph, buttons: buttons) }
        let h = zoomed(26)
        var right = footer.maxX - Self.pad
        let attrs: [NSAttributedString.Key: Any] = [.font: Self.buttonFont]
        for (action, title) in [(Action.more, ""), (.refresh, "Refresh"), (.open, "Open")] {
            let textWidth = title.isEmpty ? 0 : ceil((title as NSString).size(withAttributes: attrs).width) + zoomed(6)
            let w = zoomed(28) + textWidth
            buttons[action] = NSRect(x: right - w, y: footer.midY - h / 2, width: w, height: h)
            right -= w + zoomed(6)
        }
        buttons[.preview] = preview
        return Layout(box: box, preview: preview, footer: footer, glyph: glyph, buttons: buttons)
    }

    func action(at point: NSPoint, in frame: NSRect) -> Action? {
        let layout = layout(in: frame)
        if let hit = [Action.open, .refresh, .more].first(where: { layout.buttons[$0]?.insetBy(dx: -2, dy: -3).contains(point) == true }) {
            return hit == .refresh && refreshing ? nil : hit
        }
        return layout.buttons[.preview]?.contains(point) == true ? .preview : nil
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView?) {
        let layout = layout(in: cellFrame)
        let flipped = controlView?.isFlipped ?? true
        let path = NSBezierPath(roundedRect: layout.box, xRadius: Self.radius, yRadius: Self.radius)
        Theme.codeBackgroundOpaque.setFill()
        path.fill()

        // The preview ends at a hairline, without obscuring its content.
        if page != nil {
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            NSBezierPath(rect: layout.preview).addClip()
            if let thumb, case .drawn(let drawn)? = thumbState, let pictures = RichBlocks.shared.pictures(RichBlocks.key(thumb)) {
                let dark = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                let scale = layout.preview.width / drawn.size.width
                let rect = NSRect(x: layout.preview.minX, y: layout.preview.minY, width: layout.preview.width, height: (drawn.size.height * scale).rounded())
                NSImage(cgImage: dark ? pictures.dark : pictures.light, size: drawn.size).draw(in: rect, from: .zero, operation: .sourceOver, fraction: refreshing ? 0.35 : 1, respectFlipped: flipped, hints: [.interpolation: NSImageInterpolation.high])
            } else {
                let failed: String? = { if case .failed(let why)? = thumbState { return why } else { return nil } }()
                let text = NSAttributedString(string: failed.map { "Couldn't draw a preview: \($0)" } ?? "Drawing a preview…", attributes: [.font: Self.metaFont, .foregroundColor: NSColor.secondaryLabelColor])
                let size = text.size()
                text.draw(at: NSPoint(x: layout.preview.midX - size.width / 2, y: layout.preview.midY - size.height / 2))
            }
            if refreshing {
                let text = NSAttributedString(string: "Refreshing in its thread…", attributes: [.font: Self.buttonFont, .foregroundColor: NSColor.labelColor])
                let size = text.size()
                text.draw(at: NSPoint(x: layout.preview.midX - size.width / 2, y: layout.preview.midY - size.height / 2))
            }
            NSGraphicsContext.restoreGraphicsState()
            Theme.hairline.setFill()
            NSRect(x: layout.box.minX, y: layout.preview.maxY - 0.5, width: layout.box.width, height: 0.5).fill()
        }

        // The border goes on last, over the picture's edge.
        if isNewVersion {
            let ring = NSBezierPath(roundedRect: layout.box, xRadius: Self.radius, yRadius: Self.radius)
            NSColor.controlAccentColor.withAlphaComponent(0.55).setStroke()
            ring.lineWidth = 1
            ring.stroke()
        } else {
            Theme.cardBorder.setStroke()
            path.lineWidth = 0.5
            path.stroke()
        }

        // The footer: the kind's glyph, the title and meta, the buttons.
        NSColor.labelColor.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: layout.glyph, xRadius: zoomed(7), yRadius: zoomed(7)).fill()
        drawSymbol(page?.symbol ?? "doc.questionmark", in: layout.glyph, color: .secondaryLabelColor)
        let textLeft = layout.glyph.maxX + zoomed(10)
        let textRight = (layout.buttons[.open]?.minX ?? layout.footer.maxX - Self.pad) - zoomed(10)
        let title = NSAttributedString(string: page?.title ?? pageId, attributes: [.font: Self.titleFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: Self.truncating])
        let metaText = NSMutableAttributedString(string: meta, attributes: [.font: Self.metaFont, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: Self.truncating])
        let titleHeight = ceil(title.size().height)
        let metaHeight = ceil(metaText.size().height)
        let top = layout.footer.midY - (titleHeight + metaHeight) / 2
        // "New version" sits after the title, where there's room, so the
        // meta line keeps its age.
        var titleWidth = textRight - textLeft
        if isNewVersion {
            let pill = NSAttributedString(string: "New version", attributes: [.font: NSFont.systemFont(ofSize: TypeScale.detail - 1, weight: .medium), .foregroundColor: NSColor.controlAccentColor])
            let ps = pill.size()
            let pillWidth = ps.width + zoomed(10)
            titleWidth = min(ceil(title.size().width), titleWidth - pillWidth - zoomed(8))
            let rect = NSRect(x: textLeft + titleWidth + zoomed(8), y: top + (titleHeight - ps.height - zoomed(2)) / 2, width: pillWidth, height: ps.height + zoomed(2))
            NSColor.controlAccentColor.withAlphaComponent(0.5).setStroke()
            let pillPath = NSBezierPath(roundedRect: rect, xRadius: zoomed(4), yRadius: zoomed(4))
            pillPath.lineWidth = 0.75
            pillPath.stroke()
            pill.draw(at: NSPoint(x: rect.minX + zoomed(5), y: rect.minY + zoomed(1)))
        }
        title.draw(with: NSRect(x: textLeft, y: top, width: titleWidth, height: titleHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        let metaWidth = textRight - textLeft
        metaText.draw(with: NSRect(x: textLeft, y: top + titleHeight, width: metaWidth, height: metaHeight), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])

        for (action, symbol, label) in [(Action.open, "arrow.up.forward.square", "Open"), (.refresh, "arrow.clockwise", "Refresh"), (.more, "ellipsis", "")] {
            guard let rect = layout.buttons[action] else { continue }
            let off = action == .refresh && refreshing
            let button = NSBezierPath(roundedRect: rect, xRadius: zoomed(6), yRadius: zoomed(6))
            (action == .open ? NSColor.labelColor.withAlphaComponent(0.12) : NSColor.labelColor.withAlphaComponent(0.06)).setFill()
            button.fill()
            NSColor.labelColor.withAlphaComponent(0.14).setStroke()
            button.lineWidth = 0.5
            button.stroke()
            let color: NSColor = off ? .tertiaryLabelColor : .labelColor
            if label.isEmpty {
                drawSymbol(symbol, in: rect, color: color)
            } else {
                let text = NSAttributedString(string: label, attributes: [.font: Self.buttonFont, .foregroundColor: color])
                let ts = text.size()
                let iconRect = NSRect(x: rect.minX + zoomed(6), y: rect.minY, width: zoomed(16), height: rect.height)
                drawSymbol(symbol, in: iconRect, color: color)
                text.draw(at: NSPoint(x: iconRect.maxX + zoomed(4), y: rect.midY - ts.height / 2))
            }
        }
    }

    private static let truncating: NSParagraphStyle = {
        let s = NSMutableParagraphStyle()
        s.lineBreakMode = .byTruncatingTail
        return s
    }()

    private func drawSymbol(_ name: String, in rect: NSRect, color: NSColor) {
        let config = NSImage.SymbolConfiguration(pointSize: TypeScale.detail, weight: .regular).applying(.init(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return }
        let size = image.size
        image.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}
