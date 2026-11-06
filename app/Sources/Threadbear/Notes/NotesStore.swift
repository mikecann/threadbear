import CryptoKit
import Foundation
import Observation
import Security
import ThreadbearCore

/// Mike's notes (the bar's Notes page): on this Mac only, in
/// ~/Library/Application Support/Threadbear/notes/, one file per note,
/// each sealed with AES-GCM (NoteCrypto) under a key kept in the Keychain
/// for this app alone. The folder and files are his alone (0700, 0600).
/// Nothing here is sent anywhere: not the runner, an agent or the backend.
@MainActor
@Observable
final class NotesStore {
    static let shared = NotesStore()
    /// Settings > General's switch for the Notes button.
    static let shownKey = "notesShown"

    private(set) var notes: [Note] = []
    private(set) var loaded = false
    /// Why the notes can't be opened (no Keychain key), if they can't.
    private(set) var problem: String?

    @ObservationIgnored private var key: SymmetricKey?
    @ObservationIgnored private var saves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored let folder: URL

    init(folder: URL? = nil, key: SymmetricKey? = nil) {
        self.folder = folder ?? Self.defaultFolder
        self.key = key
    }

    /// The real app's bundle id; any other copy (the scripted dev app, a
    /// screenshot run) keeps notes and key of its own, so it never touches
    /// Mike's or leaves the real app a Keychain prompt.
    private static let realApp = "com.mikerosoft.threadbear"
    private static var bundleId: String { Bundle.main.bundleIdentifier ?? "unknown" }

    static var defaultFolder: URL {
        if bundleId == realApp {
            return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Threadbear/notes", isDirectory: true)
        }
        return FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-notes-\(bundleId)", isDirectory: true)
    }

    /// Newest first.
    var sorted: [Note] { notes.sorted { $0.updatedAt > $1.updatedAt } }

    func load() {
        guard !loaded else { return }
        do {
            let key = try self.key ?? Self.keychainKey()
            self.key = key
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
            var found: [Note] = []
            for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) where file.pathExtension == "tbnote" {
                do {
                    found.append(try NoteCrypto.open(try Data(contentsOf: file), key: key))
                } catch {
                    AppLog.write("notes", "couldn't open \(file.lastPathComponent)")
                }
            }
            notes = found
            loaded = true
            problem = nil
        } catch {
            problem = "Your notes couldn't be unlocked: the Keychain didn't give Threadbear its key."
            AppLog.write("notes", "no key: \(error.localizedDescription)")
        }
    }

    /// A new, empty note with the next free default name.
    @discardableResult
    func create() -> Note? {
        load()
        guard key != nil else { return nil }
        let note = Note(title: NoteNames.next(after: notes.map(\.title)))
        notes.append(note)
        write(note)
        return note
    }

    func rename(_ id: String, to title: String) {
        guard let i = notes.firstIndex(where: { $0.id == id }) else { return }
        let clean = NoteNames.clean(title, fallback: notes[i].title)
        guard clean != notes[i].title else { return }
        notes[i].title = clean
        notes[i].updatedAt = Date()
        write(notes[i])
    }

    /// The body as typed; written half a second after the typing stops.
    func setBody(_ id: String, _ body: String) {
        guard let i = notes.firstIndex(where: { $0.id == id }), notes[i].body != body else { return }
        notes[i].body = body
        notes[i].updatedAt = Date()
        let note = notes[i]
        saves[id]?.cancel()
        saves[id] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.write(note)
        }
    }

    /// Anything still waiting to be written, now (the page closing, the app quitting).
    func flush() {
        for (id, task) in saves {
            task.cancel()
            if let note = notes.first(where: { $0.id == id }) { write(note) }
        }
        saves = [:]
    }

    func delete(_ id: String) {
        saves[id]?.cancel()
        saves[id] = nil
        notes.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: file(id))
    }

    private func file(_ id: String) -> URL { folder.appendingPathComponent("\(id).tbnote") }

    private func write(_ note: Note) {
        guard let key else { return }
        do {
            let data = try NoteCrypto.seal(note, key: key)
            try data.write(to: file(note.id), options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file(note.id).path)
        } catch {
            AppLog.write("notes", "couldn't save a note: \(error.localizedDescription)")
        }
    }

    // MARK: The key

    private static var service: String { bundleId == realApp ? "com.mikerosoft.threadbear.notes" : "com.mikerosoft.threadbear.notes.\(bundleId)" }
    private static let account = "notes-key"

    /// The notes' key from the Keychain, made the first time.
    static func keychainKey() throws -> SymmetricKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        let key = SymmetricKey(size: .bits256)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Threadbear notes",
            // Readable only while he's logged in; not "this device only",
            // so it moves with Migration Assistant and an encrypted backup to
            // a new Mac (the notes would be unreadable there without it).
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
            kSecValueData as String: key.withUnsafeBytes { Data($0) },
        ]
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        return key
    }
}
