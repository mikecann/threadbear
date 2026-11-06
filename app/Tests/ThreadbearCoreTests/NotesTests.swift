import CryptoKit
import XCTest
@testable import ThreadbearCore

final class NotesTests: XCTestCase {
    func testSealedNotesOpenOnlyWithTheirKey() throws {
        let key = SymmetricKey(size: .bits256)
        let note = Note(title: "Plans", body: "- secret thing")
        let sealed = try NoteCrypto.seal(note, key: key)
        XCTAssertNil(String(data: sealed, encoding: .utf8)?.range(of: "secret"), "nothing readable on disk")
        XCTAssertFalse(sealed.contains(Data("secret".utf8)))
        XCTAssertEqual(try NoteCrypto.open(sealed, key: key), note)
        XCTAssertThrowsError(try NoteCrypto.open(sealed, key: SymmetricKey(size: .bits256)))
        var tampered = sealed
        tampered[tampered.count - 1] ^= 0xFF
        XCTAssertThrowsError(try NoteCrypto.open(tampered, key: key))
    }

    func testDefaultNames() {
        XCTAssertEqual(NoteNames.next(after: []), "Untitled note")
        XCTAssertEqual(NoteNames.next(after: ["Untitled note"]), "Untitled note 2")
        XCTAssertEqual(NoteNames.next(after: ["untitled note", "Untitled note 2", "Shopping"]), "Untitled note 3")
        XCTAssertEqual(NoteNames.clean("  Groceries \n list ", fallback: "x"), "Groceries   list")
        XCTAssertEqual(NoteNames.clean("   ", fallback: "Untitled note"), "Untitled note")
    }

    func testHighlighting() {
        let text = "# Title\n- **milk** and `eggs`\n> quoted\n```\ncode *not italic*\n```\nsee https://example.com"
        let kinds = NoteHighlight.spans(in: text).map(\.kind)
        XCTAssertTrue(kinds.contains(.heading))
        XCTAssertTrue(kinds.contains(.listMarker))
        XCTAssertTrue(kinds.contains(.bold))
        XCTAssertTrue(kinds.contains(.code))
        XCTAssertTrue(kinds.contains(.quote))
        XCTAssertTrue(kinds.contains(.link))
        XCTAssertFalse(kinds.contains(.italic), "inside a code block it's code")
        let ns = text as NSString
        let bold = NoteHighlight.spans(in: text).first { $0.kind == .bold }!
        XCTAssertEqual(ns.substring(with: bold.range), "**milk**")
    }
}
