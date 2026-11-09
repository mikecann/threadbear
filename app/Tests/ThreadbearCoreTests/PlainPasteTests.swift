import XCTest
@testable import ThreadbearCore

/// Copies from the transcript or a Markdown preview pasted into the
/// terminal: no stray characters a shell would take as part of a command.
final class PlainPasteTests: XCTestCase {
    func testOddSpacesBecomePlainSpaces() {
        XCTAssertEqual(PlainPaste.clean("npm\u{00A0}run\u{202F}dev"), "npm run dev")
        XCTAssertEqual(PlainPaste.clean("see\u{2009}↑"), "see ↑")
    }

    func testInvisibleCharactersGo() {
        XCTAssertEqual(PlainPaste.clean("cd /Users/\u{200B}wayne/\u{200B}code"), "cd /Users/wayne/code")
        XCTAssertEqual(PlainPaste.clean("\u{FEFF}echo hi\u{2060}"), "echo hi")
        XCTAssertEqual(PlainPaste.clean("co\u{00AD}de"), "code")
    }

    func testEmojiAndPlainTextAreLeftAlone() {
        XCTAssertEqual(PlainPaste.clean("👩‍💻 ls -la\n\tcd ~"), "👩‍💻 ls -la\n\tcd ~")
        XCTAssertEqual(PlainPaste.clean(""), "")
    }
}
