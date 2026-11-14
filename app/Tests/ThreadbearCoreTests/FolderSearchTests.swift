import Foundation
import XCTest
@testable import ThreadbearCore

/// The Files panel's search: which lines match, which files and folders
/// are read, and that it stops when asked.
final class FolderSearchTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("folder-search-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ path: String, _ text: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    func testMatchesLinesWithoutCase() {
        let found = FolderSearch.matches(in: "one\n  Hello World\nnothing\nhello again", query: "hello")
        XCTAssertEqual(found.map(\.line), [2, 4])
        XCTAssertEqual(found.map(\.text), ["Hello World", "hello again"])
        XCTAssertTrue(FolderSearch.matches(in: "abc", query: "  ").isEmpty)
    }

    func testLongLineIsCutAroundTheMatch() {
        let line = String(repeating: "a", count: 300) + "NEEDLE" + String(repeating: "b", count: 300)
        let shown = FolderSearch.matches(in: line, query: "needle")[0].text
        XCTAssertTrue(shown.contains("NEEDLE"))
        XCTAssertTrue(shown.hasPrefix("…"))
        XCTAssertTrue(shown.hasSuffix("…"))
        XCTAssertLessThanOrEqual(shown.count, FolderSearch.shownLength + 2)
    }

    func testSearchSkipsDependenciesBuildOutputAndBinaries() throws {
        try write("src/app.ts", "const port = 5173\n// TODO: port")
        try write("README.md", "Run on port 5173")
        try write(".github/workflows/ci.yml", "port: 5173")
        try write("node_modules/vite/index.js", "port 5173")
        try write(".git/config", "port 5173")
        try write("build/out.js", "port 5173")
        try Data([0, 1, 2, 0x70, 0x6f, 0x72, 0x74]).write(to: root.appendingPathComponent("logo.png"))
        let result = FolderSearch.search(root: root.path, query: "port")
        let files = Set(result.hits.map { FolderSearch.relative($0.path, to: root.path) })
        XCTAssertEqual(files, ["src/app.ts", "README.md", ".github/workflows/ci.yml"])
        XCTAssertEqual(result.hits.filter { $0.path.hasSuffix("app.ts") }.map(\.line), [1, 2])
        XCTAssertFalse(result.cut)
    }

    func testLimitCutsTheList() throws {
        try write("a.txt", (1...20).map { "match \($0)" }.joined(separator: "\n"))
        let result = FolderSearch.search(root: root.path, query: "match", limit: 5)
        XCTAssertEqual(result.hits.count, 5)
        XCTAssertTrue(result.cut)
    }

    func testStopEndsTheSearch() throws {
        try write("a.txt", "match")
        XCTAssertTrue(FolderSearch.search(root: root.path, query: "match", stop: { true }).hits.isEmpty)
    }

    func testRelativePath() {
        XCTAssertEqual(FolderSearch.relative("/x/y/src/a.ts", to: "/x/y"), "src/a.ts")
        XCTAssertEqual(FolderSearch.relative("/x/y/src/a.ts", to: "/x/y/"), "src/a.ts")
        XCTAssertEqual(FolderSearch.relative("/other/a.ts", to: "/x/y"), "/other/a.ts")
    }
}
