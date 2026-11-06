import XCTest
@testable import ThreadbearCore

final class UserMarkdownTests: XCTestCase {
    func testPlainTextStaysPlain() {
        XCTAssertNil(UserMarkdown.prepare("Can you fix the login page?\nIt breaks on Safari."))
        XCTAssertNil(UserMarkdown.prepare("snake_case_names and 2*3 are fine"))
        XCTAssertNil(UserMarkdown.prepare("#123 is still broken"))
    }

    func testListsAreMarkdown() {
        let text = "Todo:\n- milk\n- eggs"
        XCTAssertEqual(UserMarkdown.prepare(text), "Todo:\n- milk\n- eggs")
    }

    func testALineAfterAListEndsIt() {
        XCTAssertEqual(UserMarkdown.prepare("- one\n- two\nthen this\nand this"), "- one\n- two  \n\nthen this  \nand this")
    }

    func testLineBreaksAreKept() {
        XCTAssertEqual(UserMarkdown.prepare("**Note**\nline two\nline three"), "**Note**  \nline two  \nline three")
    }

    func testCodeBlocksAreLeftAlone() {
        let text = "Run this:\n```\nnpm test\nnpm run build\n```"
        XCTAssertEqual(UserMarkdown.prepare(text), "Run this:\n```\nnpm test\nnpm run build\n```")
    }

    func testInlineMarks() {
        XCTAssertNotNil(UserMarkdown.prepare("use `tb land` now"))
        XCTAssertNotNil(UserMarkdown.prepare("see [the docs](https://example.com)"))
        XCTAssertNotNil(UserMarkdown.prepare("this is *important*"))
    }
}

final class LinkedNoteTests: XCTestCase {
    func testANoteWithALinkIsNeverFoldedAway() {
        let linked = TranscriptRow(id: "n:1", seq: 1, turnId: "t", content: .note("Saved the plan to [plans/a.md](</tmp/plans/a.md>)."))
        let plain = TranscriptRow(id: "n:2", seq: 2, turnId: "t", content: .note("Resumed session"))
        XCTAssertFalse(TranscriptModel.isWork(linked))
        XCTAssertTrue(TranscriptModel.isWork(plain))
    }
}
