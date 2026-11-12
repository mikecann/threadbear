import Foundation

/// A Print, as people and agents call it since 10 Nov 2026 (the code and
/// protocol keep "page"; docs/protocol.md, "Prints"): a named, versioned page an agent
/// made, kept by the runner, in zero or more projects. The pages
/// experiment; with it off the runner sends none.
public struct Page: Sendable, Hashable, Decodable, Identifiable {
    public struct ProjectRef: Sendable, Hashable, Decodable {
        public var id: String
        public var pinned: Bool

        enum CodingKeys: String, CodingKey { case id, pinned }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
        }
    }

    public var id: String
    public var title: String
    public var summary: String
    public var ownerThread: String
    public var projects: [ProjectRef]
    public var version: Int
    public var bytes: Int
    /// Scripts allowed: they run only after Run them.
    public var live: Bool
    public var source: String?
    /// chart, dashboard, report, doc, bundle or page.
    public var kind: String
    /// How to make it again, for Refresh.
    public var recipe: String?
    /// The newest version was written in the app's editor.
    public var editedByUser: Bool
    /// Its link's slug while it's published (the website's /p/<slug>).
    public var publishedSlug: String?
    /// Set while it's deleted (kept 7 days for Restore).
    public var deletedAt: Date?
    public var updatedAt: Date

    enum CodingKeys: String, CodingKey { case id, title, summary, ownerThread, projects, version, bytes, live, source, kind, recipe, editedBy, deletedAt, updatedAt, published }
    private struct Published: Decodable { var slug: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        ownerThread = (try? c.decodeIfPresent(String.self, forKey: .ownerThread)) ?? ""
        projects = c.lossyArray(ProjectRef.self, forKey: .projects)
        version = (try? c.decodeIfPresent(Int.self, forKey: .version)) ?? 1
        bytes = (try? c.decodeIfPresent(Int.self, forKey: .bytes)) ?? 0
        live = (try? c.decodeIfPresent(Bool.self, forKey: .live)) ?? false
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? "page"
        recipe = try? c.decodeIfPresent(String.self, forKey: .recipe)
        editedByUser = ((try? c.decodeIfPresent(String.self, forKey: .editedBy)) ?? nil) == "user"
        deletedAt = ((try? c.decodeIfPresent(String.self, forKey: .deletedAt)) ?? nil).flatMap(ISO8601.parse)
        publishedSlug = ((try? c.decodeIfPresent(Published.self, forKey: .published)) ?? nil)?.slug
        updatedAt = ((try? c.decodeIfPresent(String.self, forKey: .updatedAt)) ?? nil).flatMap(ISO8601.parse) ?? .distantPast
    }

    public func isIn(project id: String) -> Bool { projects.contains { $0.id == id } }

    public var isDoc: Bool { kind == "doc" }
    public var isDiagram: Bool { kind == "diagram" }
    public var hasEditableSource: Bool { isDoc || isDiagram }

    /// What its kind is called: a plain one is a Print.
    public var kindLabel: String { kind == "page" ? "Print" : kind.capitalized }

    /// The versions the runner still keeps: the newest ten.
    public var keptVersions: [Int] { Array(Swift.max(1, version - 9)...version).reversed() }

    /// An SF Symbol for its kind.
    public var symbol: String {
        switch kind {
        case "chart": "chart.bar"
        case "dashboard": "rectangle.3.group"
        case "report": "doc.text.magnifyingglass"
        case "doc": "doc.plaintext"
        case "diagram": "point.3.connected.trianglepath.dotted"
        case "bundle": "shippingbox"
        default: "doc.richtext"
        }
    }

    /// The experiment's id, as in hello's `experiments`.
    public static let experiment = "pages"
}

public struct PagesResult: Sendable, Decodable {
    public var pages: [Page]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pages = c.lossyArray(Page.self, forKey: .pages)
    }

    enum CodingKeys: String, CodingKey { case pages }
}

/// `pages.get`: the page, and its newest `index.html` on the runner's Mac.
public struct PageGetResult: Sendable, Decodable {
    public var page: Page
    public var file: String
    public var versions: [Int]
    /// A doc's markdown, for the editor.
    public var markdown: String?
    /// A diagram's Mermaid source, kept alongside the rendered Print.
    public var mermaid: String?
}

public struct PageResult: Sendable, Decodable {
    public var page: Page
}

/// Where Refresh or Edit with Agent went.
public struct PageAskResult: Sendable, Decodable {
    public var threadId: String
    public var started: Bool
}

/// `pages.publish`: the page, and its link when the website is known.
public struct PagePublishResult: Sendable, Decodable {
    public var page: Page
    public var url: String?
}

public struct PageExportResult: Sendable, Decodable {
    public var file: String
}

/// Where a Print's version lives on the runner's Mac: `<home>/pages/<id>/v<n>/index.html`
/// (docs/protocol.md, "Prints"). A side pane showing one follows new versions.
public enum PagePath {
    /// The Print id and version a file under a pages folder belongs to.
    public static func parse(_ path: String) -> (id: String, version: Int)? {
        let parts = (path as NSString).pathComponents
        guard parts.count >= 4, parts[parts.count - 1] == "index.html",
              parts[parts.count - 4] == "pages",
              parts[parts.count - 2].hasPrefix("v"), let v = Int(parts[parts.count - 2].dropFirst()), v > 0
        else { return nil }
        return (parts[parts.count - 3], v)
    }

    /// The same Print's new newest version, when the file shown was the
    /// newest in `before` and `after` has a newer one; nil to leave it as it
    /// is. An older version opened on purpose stays put.
    public static func newer(than path: String, before: [Page], after: [Page]) -> String? {
        guard let (id, v) = parse(path), let page = after.first(where: { $0.id == id }), page.version > v, page.deletedAt == nil,
              before.first(where: { $0.id == id })?.version == v
        else { return nil }
        let folder = ((path as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
        return (((folder as NSString).appendingPathComponent("v\(page.version)")) as NSString).appendingPathComponent("index.html")
    }
}

/// Prints as rows: in a thread's Highlights (the ones it made) and in the
/// rail's Prints list (all of them), each saying which projects it's in.
public enum PrintRows {
    /// The Prints a thread made, newest first, deleted ones left out.
    public static func made(by threadId: String, in pages: [Page]) -> [Page] {
        all(pages).filter { $0.ownerThread == threadId }
    }

    /// Every Print, newest first, deleted ones left out.
    public static func all(_ pages: [Page]) -> [Page] {
        pages.filter { $0.deletedAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// "Threadbear, Poddle", or "No project". A project the app doesn't
    /// know (archived, or not loaded yet) is left out.
    public static func projects(of page: Page, titles: [String: String]) -> String {
        let names = page.projects.compactMap { titles[$0.id] }
        return names.isEmpty ? "No project" : names.joined(separator: ", ")
    }

    /// "Chart · v3", for a row's right-hand side.
    public static func kindAndVersion(_ page: Page) -> String {
        "\(page.kindLabel) · v\(page.version)"
    }
}
