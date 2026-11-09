import AppKit
import XCTest
@testable import Threadbear

/// Choosing a picture copies it into the looks folder, scaled down: a photo
/// as a JPEG, one with see-through parts as a PNG. Wayne's photos are HEIC
/// from his iPhone as often as JPEG.
@MainActor
final class LooksImportTests: XCTestCase {
    private func sample(_ ext: String) throws -> URL {
        let source = URL(fileURLWithPath: "/System/Library/Desktop Pictures/Mac Purple.heic")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: source.path), "no sample photo on this Mac")
        if ext == "heic" { return source }
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("looks-sample-\(UUID().uuidString).\(ext)")
        let image = try XCTUnwrap(NSImage(contentsOf: source))
        let rep = try XCTUnwrap(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
        try XCTUnwrap(rep.representation(using: ext == "png" ? .png : .jpeg, properties: [:])).write(to: out)
        return out
    }

    func testPhotosAreCopiedInScaledDown() throws {
        for ext in ["heic", "jpg"] {
            let name = try XCTUnwrap(Looks.importPicture(from: try sample(ext), maxSide: 1200, prefix: "test"), ext)
            defer { Looks.remove(name) }
            XCTAssertTrue(name.hasPrefix("test-"))
            let copy = try XCTUnwrap(Looks.image(name), ext)
            let rep = try XCTUnwrap(copy.representations.first)
            XCTAssertLessThanOrEqual(max(rep.pixelsWide, rep.pixelsHigh), 1200, ext)
        }
    }

    func testSomethingThatIsntAPictureIsRefused() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("not-a-picture-\(UUID().uuidString).jpg")
        try Data("hello".utf8).write(to: file)
        XCTAssertNil(Looks.importPicture(from: file, maxSide: 1200, prefix: "test"))
    }
}
