import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// The Customize panel's binding keeps every change when several are made
/// in a row. Choosing your own picture sets the file, then the choice, then
/// shows it; reading a stale copy between them undid the first and deleted
/// the new picture as unused (8 Nov).
@MainActor
final class LooksBindingTests: XCTestCase {
    func testChangesInARowAllStick() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "LooksBindingTests-\(UUID().uuidString)"))
        let look = Looks.librarianBinding(defaults)
        look.wrappedValue.pictureFile = "picture-test.png"
        look.wrappedValue.picture = .own
        look.wrappedValue.setShown(true, for: .picture)
        look.wrappedValue.greetingName = "Wayne"
        let saved = Looks.librarianLook(defaults)
        XCTAssertEqual(saved.pictureFile, "picture-test.png")
        XCTAssertEqual(saved.picture, .own)
        XCTAssertEqual(saved.greetingName, "Wayne")
    }

    func testANewPictureIsntDeletedAsUnused() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "LooksBindingTests-\(UUID().uuidString)"))
        try FileManager.default.createDirectory(at: Looks.folder, withIntermediateDirectories: true)
        let name = "picture-binding-test.png"
        let file = Looks.folder.appendingPathComponent(name)
        try Data("x".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let look = Looks.librarianBinding(defaults)
        look.wrappedValue.pictureFile = name
        look.wrappedValue.picture = .own
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "the picture just chosen is still there")
    }
}
