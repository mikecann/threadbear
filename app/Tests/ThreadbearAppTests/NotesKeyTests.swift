import CryptoKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// The notes' key lives in a file (secrets/notes-key), not the Keychain,
/// so Notes never asks for the Mac password after an update. The first
/// load moves an old Keychain key into the file and deletes the item.
@MainActor
final class NotesKeyTests: XCTestCase {
    private var dir: URL!
    private var service: String!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("notes-key-\(UUID().uuidString)")
        service = "com.mikerosoft.threadbear.notes.test-\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        NotesStore.deleteKeychainKey(service: service)
        try? FileManager.default.removeItem(at: dir)
    }

    private var notes: URL { dir.appendingPathComponent("notes") }
    private var keyFile: URL { dir.appendingPathComponent("secrets/notes-key") }

    func testANewKeyGoesInAFileOnlyYouCanRead() throws {
        let store = NotesStore(folder: notes, keyFile: keyFile, keychainService: service)
        store.load()
        XCTAssertNil(store.problem)
        let data = try Data(contentsOf: keyFile)
        XCTAssertEqual(data.count, 32)
        let mode = try FileManager.default.attributesOfItem(atPath: keyFile.path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
        let dirMode = try FileManager.default.attributesOfItem(atPath: keyFile.deletingLastPathComponent().path)[.posixPermissions] as? Int
        XCTAssertEqual(dirMode, 0o700)
        if case .found = NotesStore.readKeychainKey(service: service, prompt: false) { XCTFail("nothing goes in the Keychain") }
    }

    func testNotesWrittenWithTheFileKeyOpenAgain() throws {
        let first = NotesStore(folder: notes, keyFile: keyFile, keychainService: service)
        first.load()
        let note = try XCTUnwrap(first.create())
        first.setBody(note.id, "remember the milk")
        first.flush()
        let again = NotesStore(folder: notes, keyFile: keyFile, keychainService: service)
        again.load()
        XCTAssertEqual(again.notes.first?.body, "remember the milk")
    }

    func testAnOldKeychainKeyMovesToTheFileAndKeepsTheNotesReadable() throws {
        // Notes made the old way: the key in the Keychain.
        let old = SymmetricKey(size: .bits256)
        let added = NotesStore.putKeychainKey(old, service: service)
        try XCTSkipIf(added != errSecSuccess, "no Keychain to test with here (\(added))")
        let before = NotesStore(folder: notes, key: old, keyFile: keyFile, keychainService: service)
        before.load()
        let note = try XCTUnwrap(before.create())
        before.setBody(note.id, "from the Keychain days")
        before.flush()

        let after = NotesStore(folder: notes, keyFile: keyFile, keychainService: service)
        after.load()
        XCTAssertNil(after.problem)
        XCTAssertEqual(after.notes.first?.body, "from the Keychain days")
        XCTAssertEqual(try Data(contentsOf: keyFile), old.withUnsafeBytes { Data($0) })
        if case .found = NotesStore.readKeychainKey(service: service, prompt: false) { XCTFail("the Keychain item is deleted") }
    }
}
