import Foundation
import XCTest
@testable import ThreadbearCore

/// ⌘-click in the Terminal panel: which web address is under the pointer,
/// and that nothing but http and https ever comes out.
final class TerminalLinksTests: XCTestCase {
    private func link(_ line: String, at needle: String, offset: Int = 2) -> String? {
        guard let range = line.range(of: needle) else { XCTFail("no \(needle) in \(line)"); return nil }
        let column = line.distance(from: line.startIndex, to: range.lowerBound) + offset
        return TerminalLinks.link(in: line, at: column)?.absoluteString
    }

    func testViteLocalLine() {
        let line = "  ➜  Local:   http://localhost:5175/"
        XCTAssertEqual(link(line, at: "http"), "http://localhost:5175/")
        XCTAssertEqual(link(line, at: "5175"), "http://localhost:5175/")
        XCTAssertNil(link(line, at: "Local"))
    }

    func testBareLocalhostGetsHttp() {
        XCTAssertEqual(link("Listening on localhost:3000", at: "localhost"), "http://localhost:3000")
        XCTAssertEqual(link("at 127.0.0.1:8080/api.", at: "127"), "http://127.0.0.1:8080/api")
    }

    func testTrailingPunctuationAndBrackets() {
        XCTAssertEqual(link("See (https://example.com/docs).", at: "https"), "https://example.com/docs")
        XCTAssertEqual(link("https://en.wikipedia.org/wiki/Foo_(bar), ok", at: "https"), "https://en.wikipedia.org/wiki/Foo_(bar)")
        XCTAssertEqual(link("Deployed to https://app.convex.site!", at: "https"), "https://app.convex.site")
    }

    func testOnlyWebSchemes() {
        XCTAssertNil(link("open file:///etc/passwd now", at: "file"))
        XCTAssertNil(link("vscode://extension/x", at: "vscode"))
        XCTAssertNil(link("x-apple.systempreferences:com.apple", at: "x-apple"))
        XCTAssertNil(link("javascript:alert(1)", at: "javascript"))
        XCTAssertNil(link("http:// nothing", at: "http"))
    }

    func testSpanCoversJustTheLink() {
        let line = "  Local:   http://localhost:5175/."
        let span = TerminalLinks.span(in: line, at: 14)
        XCTAssertEqual(span?.columns, 11..<33)
        XCTAssertEqual(span?.url.absoluteString, "http://localhost:5175/")
    }

    func testOutOfRangeColumns() {
        XCTAssertNil(TerminalLinks.link(in: "http://localhost:1", at: -1))
        XCTAssertNil(TerminalLinks.link(in: "http://localhost:1", at: 99))
        XCTAssertNil(TerminalLinks.link(in: "", at: 0))
    }

    func testAllLinksInText() {
        let text = "Local: http://localhost:5173/ Network: https://192.168.1.4:5173/ and ftp://x"
        XCTAssertEqual(TerminalLinks.links(in: text).map(\.absoluteString), ["http://localhost:5173/", "https://192.168.1.4:5173/"])
    }
}
