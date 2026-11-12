import XCTest
@testable import ThreadbearCore

final class PageTests: XCTestCase {
    func testDiagramSourceAndIconDecodeWithoutAffectingOlderPages() throws {
        let json = #"{"page":{"id":"pg_flow","title":"Flow","kind":"diagram"},"file":"/flow/index.html","versions":[1],"mermaid":"flowchart LR\n A --> B"}"#
        let result = try JSONDecoder().decode(PageGetResult.self, from: Data(json.utf8))
        XCTAssertTrue(result.page.isDiagram)
        XCTAssertTrue(result.page.hasEditableSource)
        XCTAssertFalse(result.page.isDoc)
        XCTAssertEqual(result.page.symbol, "point.3.connected.trianglepath.dotted")
        XCTAssertEqual(result.mermaid, "flowchart LR\n A --> B")
        XCTAssertNil(try JSONDecoder().decode(PageGetResult.self, from: Data(#"{"page":{"id":"pg_old","title":"Old"},"file":"/old","versions":[1]}"#.utf8)).mermaid)
    }

    func testAPageDecodesAsTheRunnerSendsIt() throws {
        let json = """
        {"pages":[{"id":"pg_bundle_size","title":"Bundle size","summary":"20.22 MB total","ownerThread":"th1",
        "projects":[{"id":"p_tb","by":"agent","pinned":true},{"id":"p_x","by":"mike"}],"version":3,"bytes":90123,"live":false,
        "source":"bundle-analyzer summary","createdAt":"2026-11-10T09:00:00.000Z","updatedAt":"2026-11-10T09:30:00.000Z"},
        {"id":"broken"}]}
        """
        let pages = try JSONDecoder().decode(PagesResult.self, from: Data(json.utf8)).pages
        XCTAssertEqual(pages.count, 1, "one without a title is dropped, not the whole list")
        let page = try XCTUnwrap(pages.first)
        XCTAssertEqual(page.version, 3)
        XCTAssertEqual(page.source, "bundle-analyzer summary")
        XCTAssertTrue(page.isIn(project: "p_tb"))
        XCTAssertTrue(page.isIn(project: "p_x"))
        XCTAssertFalse(page.isIn(project: "p_other"))
        XCTAssertEqual(page.projects.map(\.pinned), [true, false])
        XCTAssertEqual(page.updatedAt, ISO8601.parse("2026-11-10T09:30:00.000Z"))
    }

    func testASidePaneShowingAPrintFollowsItsNewestVersion() throws {
        let page = { (id: String, v: Int, deleted: Bool) in
            try JSONDecoder().decode(Page.self, from: Data(#"{"id":"\#(id)","title":"T","version":\#(v)\#(deleted ? #","deletedAt":"2026-11-11T00:00:00Z""# : "")}"#.utf8))
        }
        let shown = "/Users/w/Library/Application Support/Threadbear/pages/pg_sales/v2/index.html"
        XCTAssertEqual(PagePath.parse(shown)?.id, "pg_sales")
        XCTAssertEqual(PagePath.parse(shown)?.version, 2)
        let was = [try page("pg_sales", 2, false)]
        XCTAssertEqual(PagePath.newer(than: shown, before: was, after: [try page("pg_other", 9, false), try page("pg_sales", 4, false)]),
                       "/Users/w/Library/Application Support/Threadbear/pages/pg_sales/v4/index.html")
        XCTAssertNil(PagePath.newer(than: shown, before: was, after: was), "already the newest")
        XCTAssertNil(PagePath.newer(than: shown, before: [try page("pg_sales", 3, false)], after: [try page("pg_sales", 4, false)]),
                     "an older version opened on purpose stays")
        XCTAssertNil(PagePath.newer(than: shown, before: was, after: [try page("pg_sales", 5, true)]), "a deleted one stays as it was")
        XCTAssertNil(PagePath.newer(than: shown, before: was, after: []))
        for other in ["/Users/w/dev/site/v2/index.html", "/Users/w/pages/pg_a/v2/chart.svg", "/Users/w/pages/pg_a/vx/index.html", "index.html"] {
            XCTAssertNil(PagePath.parse(other), other)
        }
    }

    func testAPublishedPageCarriesItsLinksSlug() throws {
        let json = #"{"id":"pg_a","title":"A","version":2,"published":{"slug":"abcDEF0123456789abcdef","at":"2026-11-10T09:30:00Z","version":2}}"#
        XCTAssertEqual(try JSONDecoder().decode(Page.self, from: Data(json.utf8)).publishedSlug, "abcDEF0123456789abcdef")
        XCTAssertNil(try JSONDecoder().decode(Page.self, from: Data(#"{"id":"pg_a","title":"A"}"#.utf8)).publishedSlug)
    }

    func testAPageInNoProjectIsInNone() throws {
        let json = #"{"id":"pg_a","title":"A","summary":"","ownerThread":"t","projects":[],"version":1,"bytes":1,"live":true,"updatedAt":"2026-11-10T09:30:00Z"}"#
        let page = try JSONDecoder().decode(Page.self, from: Data(json.utf8))
        XCTAssertTrue(page.projects.isEmpty)
        XCTAssertTrue(page.live)
    }

    func testKindsRecipeEditsAndDeletionDecode() throws {
        let json = #"{"id":"pg_d","title":"Plan","summary":"","ownerThread":"t","projects":[],"version":12,"bytes":1,"live":false,"kind":"doc","recipe":"write it","editedBy":"user","deletedAt":"2026-11-10T09:30:00Z","updatedAt":"2026-11-10T09:30:00Z"}"#
        let page = try JSONDecoder().decode(Page.self, from: Data(json.utf8))
        XCTAssertTrue(page.isDoc)
        XCTAssertEqual(page.symbol, "doc.plaintext")
        XCTAssertEqual(page.recipe, "write it")
        XCTAssertTrue(page.editedByUser)
        XCTAssertNotNil(page.deletedAt)
        XCTAssertEqual(page.keptVersions, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3], "the newest ten, newest first")
        let old = try JSONDecoder().decode(Page.self, from: Data(#"{"id":"pg_o","title":"Old","version":2}"#.utf8))
        XCTAssertEqual(old.kind, "page", "a page from before kinds")
        XCTAssertEqual(old.kindLabel, "Print")
        XCTAssertEqual(page.kindLabel, "Doc")
        XCTAssertEqual(old.keptVersions, [2, 1])
        XCTAssertFalse(old.editedByUser)
    }

    func testPrintRowsForHighlightsAndTheRailList() throws {
        let json = #"""
        {"pages":[
          {"id":"pg_old","title":"Old","ownerThread":"th1","version":1,"kind":"chart","projects":[{"id":"p_tb"}],"updatedAt":"2026-11-10T09:00:00Z"},
          {"id":"pg_new","title":"New","ownerThread":"th1","version":3,"kind":"doc","projects":[{"id":"p_tb"},{"id":"p_pod"},{"id":"p_gone"}],"updatedAt":"2026-11-11T09:00:00Z"},
          {"id":"pg_other","title":"Other","ownerThread":"th2","version":1,"projects":[],"updatedAt":"2026-11-11T08:00:00Z"},
          {"id":"pg_deleted","title":"Deleted","ownerThread":"th1","version":2,"projects":[],"updatedAt":"2026-11-11T10:00:00Z","deletedAt":"2026-11-11T10:00:00Z"}
        ]}
        """#
        let pages = try JSONDecoder().decode(PagesResult.self, from: Data(json.utf8)).pages
        XCTAssertEqual(PrintRows.made(by: "th1", in: pages).map(\.id), ["pg_new", "pg_old"], "newest first, deleted left out")
        XCTAssertEqual(PrintRows.all(pages).map(\.id), ["pg_new", "pg_other", "pg_old"])
        let titles = ["p_tb": "Threadbear", "p_pod": "Poddle"]
        let new = try XCTUnwrap(pages.first { $0.id == "pg_new" })
        XCTAssertEqual(PrintRows.projects(of: new, titles: titles), "Threadbear, Poddle", "an unknown project is left out")
        XCTAssertEqual(PrintRows.projects(of: try XCTUnwrap(pages.first { $0.id == "pg_other" }), titles: titles), "No project")
        XCTAssertEqual(PrintRows.kindAndVersion(new), "Doc · v3")
    }
}

final class PageFenceTests: XCTestCase {
    func testAPageFenceNamesItsPage() {
        XCTAssertEqual(PageFence.id(language: "page pg_bundle_size", code: ""), "pg_bundle_size")
        XCTAssertEqual(PageFence.id(language: "print pg_bundle_size", code: ""), "pg_bundle_size")
        XCTAssertEqual(PageFence.id(language: "print", code: "pg_sales_2026\n"), "pg_sales_2026")
        XCTAssertNil(PageFence.id(language: "printer pg_a", code: ""))
        XCTAssertEqual(PageFence.id(language: "page", code: "pg_sales_2026\n"), "pg_sales_2026")
        XCTAssertEqual(PageFence.id(language: "PAGE", code: "  pg_a  "), "pg_a")
        XCTAssertNil(PageFence.id(language: "page", code: "not a page"))
        XCTAssertNil(PageFence.id(language: "page", code: ""))
        XCTAssertNil(PageFence.id(language: "html", code: "pg_a"))
        XCTAssertNil(PageFence.id(language: "page pg_Bad", code: ""), "ids are lower case")
        XCTAssertNil(PageFence.id(language: "page pg_", code: ""))
    }

    func testAPageThumbIsANewDrawingPerVersion() {
        let v1 = RichBlock.pageThumb(file: "/p/pg_a/v1/index.html", version: 1)
        let v2 = RichBlock.pageThumb(file: "/p/pg_a/v2/index.html", version: 2)
        XCTAssertNotEqual(v1.id, v2.id)
        XCTAssertEqual(v1.pageFile, "/p/pg_a/v1/index.html")
        XCTAssertNil(RichBlock(kind: .html, source: "<p>").pageFile)
        XCTAssertNil(RichBlock.from(language: "page", code: "pg_a"), "a page fence is never an html or mermaid box")
    }
}

final class PagePDFTests: XCTestCase {
    /// A tall one-page PDF, as WebKit makes one, with a mark near the bottom.
    private func tall(width: CGFloat, height: CGFloat) -> Data {
        let out = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: width, height: height)
        let ctx = CGContext(consumer: CGDataConsumer(data: out as CFMutableData)!, mediaBox: &box, nil)!
        ctx.beginPDFPage(nil)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 10, y: 10, width: 50, height: 50))
        ctx.endPDFPage()
        ctx.closePDF()
        return out as Data
    }

    func testATallPageIsCutIntoLetterPages() throws {
        // 800 wide scales to 540 pt; a Letter page holds 720 pt, about 1067 px.
        XCTAssertEqual(PagePDF.pageCount(sourceWidth: 800, sourceHeight: 1000), 1)
        XCTAssertEqual(PagePDF.pageCount(sourceWidth: 800, sourceHeight: 1067), 1)
        XCTAssertEqual(PagePDF.pageCount(sourceWidth: 800, sourceHeight: 3000), 3)
        let pdf = try XCTUnwrap(PagePDF.paginate(tall(width: 800, height: 3000)))
        let doc = try XCTUnwrap(CGPDFDocument(CGDataProvider(data: pdf as CFData)!))
        XCTAssertEqual(doc.numberOfPages, 3)
        XCTAssertEqual(doc.page(at: 1)?.getBoxRect(.mediaBox).size, PagePDF.paper)
    }

    func testNotAPDFGivesNothing() {
        XCTAssertNil(PagePDF.paginate(Data("not a pdf".utf8)))
    }
}
