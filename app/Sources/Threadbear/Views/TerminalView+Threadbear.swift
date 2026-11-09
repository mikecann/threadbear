import AppKit
import Darwin
import SwiftTerm
import ThreadbearCore

/// The Terminal panel's terminal (TerminalPanel.swift): SwiftTerm's, with
/// links underlined as the pointer goes over them, ⌘-click opening only web
/// pages, and paste without the invisible characters copies carry.
final class ThreadTerminalView: LocalProcessTerminalView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        // SwiftTerm finds addresses in what's printed (a dev server's
        // http://localhost:5173/) and links a program marks; underline one
        // when the pointer is over it, not only while ⌘ is down.
        linkReporting = .implicit
        linkHighlightMode = .hover
    }

    required init?(coder: NSCoder) { nil }

    /// A click on an underlined link. Only ⌘-click opens it, so a click to
    /// put the cursor there or start a selection doesn't, and only a web
    /// page: SwiftTerm's own would hand macOS a `file:` link or an app's
    /// scheme that a program printed.
    override func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard NSEvent.modifierFlags.contains(.command), let url = Self.webAddress(link) else { return }
        OpenGate.openWeb(url)
    }

    /// An http or https address, or a bare `localhost:5173`, else nil.
    static func webAddress(_ link: String) -> URL? {
        LinkPolicy.web(link.trimmingCharacters(in: .whitespacesAndNewlines)) ?? TerminalLinks.links(in: link).first
    }

    /// Paste with no-break and zero-width spaces made plain (PlainPaste),
    /// as copies from the transcript and the Markdown preview have them and
    /// the shell would take them as part of a command. The clipboard is put
    /// back as it was straight after, so pasting it elsewhere still has its
    /// formatting and links.
    override func paste(_ sender: Any) {
        // SwiftTerm's paste reads the general pasteboard itself.
        Self.cleaned(.general) { super.paste(sender) }
    }

    /// Runs `paste` with `board` holding its text made plain, then puts
    /// back everything it held before.
    static func cleaned(_ board: NSPasteboard, paste: () -> Void) {
        guard let text = board.string(forType: .string) else { return paste() }
        let clean = PlainPaste.clean(text)
        guard clean != text else { return paste() }
        let saved = copy(of: board)
        board.clearContents()
        board.setString(clean, forType: .string)
        paste()
        board.clearContents()
        if !saved.isEmpty { board.writeObjects(saved) }
    }

    private static func copy(of board: NSPasteboard) -> [NSPasteboardItem] {
        (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
    }

    /// The last lines the terminal showed, for bringing a tab back after the
    /// app restarts. Trailing blank lines are left off.
    func screenText(lastLines limit: Int) -> [String] {
        // SwiftTerm keeps its buffer to itself, so this reads it with a
        // select-all, and leaves nothing selected. It runs as the app quits.
        selectAll()
        let text = getSelection() ?? ""
        selectNone()
        var lines: [String] = text.components(separatedBy: "\n").map(Self.trimmedEnd)
        while lines.last?.isEmpty == true { lines.removeLast() }
        while lines.first?.isEmpty == true { lines.removeFirst() }
        return Array(lines.suffix(limit))
    }

    private static func trimmedEnd(_ line: String) -> String {
        var line = Substring(line)
        while let last = line.last, last == " " || last == "\r" || last == "\0" { line.removeLast() }
        return String(line)
    }
}

/// Where each thread's terminal tabs were when the app last quit: their
/// folders, names and the last lines they showed, so ⌘J on that thread
/// brings them back as Terminal does its windows. Kept in terminals.json
/// in the data folder, readable only by you, as a terminal can show
/// anything. A thread's entry goes when the thread is archived or deleted.
@MainActor
final class TerminalMemory {
    struct Tab: Codable, Equatable {
        var name: String?
        var cwd: String
        var screen: [String]
    }

    struct Saved: Codable, Equatable {
        var tabs: [Tab]
        var selected: Int
    }

    /// Lines kept of each tab's screen and scrollback.
    static let linesKept = 400

    private let file: URL
    private var saved: [String: Saved]

    init(file: URL) {
        self.file = file
        saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String: Saved].self, from: $0) } ?? [:]
    }

    /// A target's tabs from last time, taken: once they're back they're
    /// the live ones, saved again at quit.
    func take(_ key: String) -> Saved? {
        guard let entry = saved.removeValue(forKey: key) else { return nil }
        save()
        return entry
    }

    func remember(_ key: String, _ entry: Saved) {
        saved[key] = entry
    }

    func forget(_ key: String) {
        guard saved.removeValue(forKey: key) != nil else { return }
        save()
    }

    func forget(where drop: (String) -> Bool) {
        let keys = saved.keys.filter(drop)
        guard !keys.isEmpty else { return }
        keys.forEach { saved[$0] = nil }
        save()
    }

    func save() {
        if saved.isEmpty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600]) {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }

    /// The folder a process is in, asked of the system, so it works
    /// whatever the shell (it needn't say where it is, as zsh does only
    /// for Apple's Terminal).
    nonisolated static func directory(of pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        let path = withUnsafeBytes(of: info.pvi_cdir.vip_path) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return path.isEmpty ? nil : path
    }
}
