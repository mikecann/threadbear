import CryptoKit
import Foundation
import Observation
import Security
import ThreadbearCore

/// Mike's notes (the bar's Notes page): on this Mac only, in
/// ~/Library/Application Support/Threadbear/notes/, one file per note,
/// each sealed with AES-GCM (NoteCrypto) under a key kept beside
/// Threadbear's other secrets, in secrets/notes-key. Folders and files are
/// his alone (0700, 0600). Nothing here is sent anywhere: not the runner,
/// an agent or the backend.
///
/// The key was a Keychain item until 7 Nov. macOS ties an item's access to
/// the app's signature, and Threadbear re-signs itself on every update, so
/// each update asked for the Mac password before Notes would open.
/// The first load moves it into the file and deletes the Keychain item.
@MainActor
@Observable
final class NotesStore {
    static let shared = NotesStore()
    /// Settings > General's switch for the Notes button.
    static let shownKey = "notesShown"

    private(set) var notes: [Note] = []
    private(set) var loaded = false
    /// Why the notes can't be opened (no key), if they can't.
    private(set) var problem: String?

    @ObservationIgnored private var key: SymmetricKey?
    @ObservationIgnored private var saves: [String: Task<Void, Never>] = [:]
    @ObservationIgnored let folder: URL
    @ObservationIgnored let keyFile: URL
    @ObservationIgnored let keychainService: String

    init(folder: URL? = nil, key: SymmetricKey? = nil, keyFile: URL? = nil, keychainService: String? = nil) {
        self.folder = folder ?? Self.defaultFolder
        self.key = key
        self.keyFile = keyFile ?? Self.defaultKeyFile
        self.keychainService = keychainService ?? Self.service
    }

    /// The real app's bundle id; any other copy (the scripted dev app, a
    /// screenshot run) keeps notes and key of its own, so it never touches
    /// Mike's or leaves the real app a Keychain prompt.
    private static let realApp = "com.mikerosoft.threadbear"
    private static var bundleId: String { Bundle.main.bundleIdentifier ?? "unknown" }

    static var defaultFolder: URL {
        // In the profile's own folder: Work's notes are never Personal's.
        if bundleId == realApp { return RunnerConfig.dataDir().appendingPathComponent("notes", isDirectory: true) }
        return FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-notes-\(bundleId)", isDirectory: true)
    }

    /// secrets/notes-key in the real app's data folder; a copy's own beside its notes.
    static var defaultKeyFile: URL {
        if bundleId == realApp { return RunnerConfig.dataDir().appendingPathComponent("secrets/notes-key") }
        return FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-notes-key-\(bundleId)")
    }

    /// Newest first.
    var sorted: [Note] { notes.sorted { $0.updatedAt > $1.updatedAt } }

    func load() {
        guard !loaded else { return }
        do {
            let key = try self.key ?? Self.loadKey(file: keyFile, keychainService: keychainService, hasNotes: hasNoteFiles)
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
            problem = "Your notes couldn't be unlocked: Threadbear couldn't read their key."
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

    private var hasNoteFiles: Bool {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).contains { $0.hasSuffix(".tbnote") }
    }

    // MARK: The key

    /// The old Keychain item's name. Only Personal ever had one: a
    /// profile's is a name that never existed, so its first load makes a
    /// new key and never moves (or deletes) Personal's.
    @MainActor static var service: String {
        let base = bundleId == realApp ? "com.mikerosoft.threadbear.notes" : "com.mikerosoft.threadbear.notes.\(bundleId)"
        guard let profile = AppProfile.current, !profile.isPersonal else { return base }
        return "\(base).profile.\(profile.id)"
    }
    private static let account = "notes-key"

    /// The notes' key from its file. The first time, the key moves there
    /// from the Keychain, where it used to be: read without a prompt if
    /// macOS allows, else asked for one last time, and only when there are
    /// notes it would open. With nothing to move, a new key is made.
    static func loadKey(file: URL, keychainService: String, hasNotes: Bool) throws -> SymmetricKey {
        if let data = try? Data(contentsOf: file), data.count == 32 { return SymmetricKey(data: data) }
        var key: SymmetricKey?
        var fromKeychain = false
        switch readKeychainKey(service: keychainService, prompt: false) {
        case .found(let old):
            key = old
            fromKeychain = true
        case .needsPrompt where hasNotes:
            if case .found(let old) = readKeychainKey(service: keychainService, prompt: true) {
                key = old
                fromKeychain = true
            } else {
                // Without it the notes can't be opened; nothing is replaced.
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(errSecAuthFailed))
            }
        default:
            break
        }
        let made = key ?? SymmetricKey(size: .bits256)
        try writeKey(made, to: file)
        if fromKeychain { deleteKeychainKey(service: keychainService) }
        return made
    }

    enum KeychainRead { case found(SymmetricKey), none, needsPrompt }

    static func readKeychainKey(service: String, prompt: Bool) -> KeychainRead {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if !prompt { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUISkip }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, data.count == 32 { return .found(SymmetricKey(data: data)) }
        if status == errSecInteractionNotAllowed || status == errSecAuthFailed { return .needsPrompt }
        return .none
    }

    static func deleteKeychainKey(service: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Written whole and readable by him alone (0600, its folder 0700).
    static func writeKey(_ key: SymmetricKey, to file: URL) throws {
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temp = dir.appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString)")
        guard fm.createFile(atPath: temp.path, contents: key.withUnsafeBytes { Data($0) }, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        if fm.fileExists(atPath: file.path) { try fm.removeItem(at: file) }
        try fm.moveItem(at: temp, to: file)
    }

    /// For tests: puts a key in the Keychain under `service`, as the old store did.
    static func putKeychainKey(_ key: SymmetricKey, service: String) -> OSStatus {
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrLabel as String: "Threadbear notes",
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
            kSecValueData as String: key.withUnsafeBytes { Data($0) },
        ]
        return SecItemAdd(add as CFDictionary, nil)
    }
}
