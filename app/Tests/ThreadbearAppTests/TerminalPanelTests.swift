import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Where the Terminal panel's shell runs, and what it's handed. None of
/// these start a shell.
@MainActor
final class TerminalPanelTests: XCTestCase {
    private let home = NSHomeDirectory()
    private var scratch: URL!

    override func setUp() async throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("terminal-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    func testNoThreadIsAShellInHome() {
        let target = TerminalTarget.for(nil) { _ in nil }
        XCTAssertEqual(target, TerminalTarget(key: "home", cwd: home))
    }

    func testALocalThreadGetsItsOwnShellInItsFolder() {
        let folder = FileManager.default.temporaryDirectory.path
        let thread = ThreadSummary(id: "t1", title: "Work", cwd: folder)
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target, TerminalTarget(key: "t1", cwd: folder))
    }

    func testARemoteThreadSharesTheHomeShellAndSaysWhere() {
        var thread = ThreadSummary(id: "t2", title: "Elsewhere", cwd: FileManager.default.temporaryDirectory.path)
        thread.runnerId = "bruce"
        let target = TerminalTarget.for(thread) { _ in "bruce" }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertEqual(target.note?.contains("on bruce"), true)
    }

    func testAThreadWhoseFolderHasGoneSharesTheHomeShell() {
        let thread = ThreadSummary(id: "t3", title: "Gone", cwd: "/no/such/folder/\(UUID().uuidString)")
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertNotNil(target.note)
    }

    /// An archived thread's worktree may be another thread's now, so its
    /// terminal is the home one, never a shell in that folder.
    func testAnArchivedThreadSharesTheHomeShell() {
        let thread = ThreadSummary(id: "t4", title: "Done", cwd: FileManager.default.temporaryDirectory.path, archivedAt: Date())
        let target = TerminalTarget.for(thread) { _ in nil }
        XCTAssertEqual(target.key, "home")
        XCTAssertEqual(target.cwd, home)
        XCTAssertEqual(target.note?.contains("archived"), true)
    }

    /// `tb` reads a thread id as "I'm that thread's agent", so the shell
    /// must never have one, under either name.
    func testTheShellIsNeverHandedAThreadId() {
        let env = TerminalSession.environment(from: [
            "THREADBEAR_THREAD_ID": "abc", "THREADBARE_THREAD_ID": "abc", "PATH": "/usr/bin", "LANG": "",
        ])
        XCTAssertFalse(env.contains { $0.hasPrefix("THREADBEAR_THREAD_ID=") })
        XCTAssertFalse(env.contains { $0.hasPrefix("THREADBARE_THREAD_ID=") })
        XCTAssertTrue(env.contains("PATH=/usr/bin"))
        XCTAssertTrue(env.contains("TERM=xterm-256color"))
        XCTAssertTrue(env.contains("LANG=en_US.UTF-8"))
    }

    /// Looking at a thread with the panel open starts nothing; only `open`
    /// (⌘J, or a click on the empty panel) does.
    func testLookingStartsNoShell() {
        let terminals = Terminals(memoryFile: scratch.appendingPathComponent("terminals.json"))
        XCTAssertNil(terminals.existing(for: TerminalTarget(key: "t1", cwd: home)))
        XCTAssertTrue(terminals.debugSummary.isEmpty)
    }

    // MARK: Tabs remembered between launches

    func testTabsAreRememberedOnceAndOwnerOnly() throws {
        let file = scratch.appendingPathComponent("terminals.json")
        let memory = TerminalMemory(file: file)
        let saved = TerminalMemory.Saved(tabs: [
            .init(name: "Dev server", cwd: "/tmp", screen: ["  Local:   http://localhost:5173/"]),
            .init(name: nil, cwd: home, screen: []),
        ], selected: 1)
        memory.remember("t1", saved)
        memory.save()
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        // A fresh launch reads it, and taking it leaves nothing behind.
        let next = TerminalMemory(file: file)
        XCTAssertEqual(next.take("t1"), saved)
        XCTAssertNil(next.take("t1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testArchivedAndDeletedThreadsAreForgotten() {
        let file = scratch.appendingPathComponent("terminals.json")
        let memory = TerminalMemory(file: file)
        for key in ["t1", "t2", "home"] { memory.remember(key, .init(tabs: [.init(name: nil, cwd: home, screen: [])], selected: 0)) }
        memory.save()
        let terminals = Terminals(memoryFile: file)
        terminals.stopAll(except: ["t2"])
        XCTAssertNil(terminals.memory.take("t1"))
        XCTAssertNotNil(terminals.memory.take("t2"))
        XCTAssertNotNil(terminals.memory.take("home"))
    }

    func testAShellsFolderIsReadFromTheSystem() {
        XCTAssertEqual(TerminalMemory.directory(of: getpid()), FileManager.default.currentDirectoryPath)
    }

    // MARK: Links

    func testOnlyWebAddressesOpen() {
        XCTAssertEqual(ThreadTerminalView.webAddress("http://localhost:5173/")?.absoluteString, "http://localhost:5173/")
        XCTAssertEqual(ThreadTerminalView.webAddress("localhost:3000")?.absoluteString, "http://localhost:3000")
        XCTAssertNil(ThreadTerminalView.webAddress("file:///etc/hosts"))
        XCTAssertNil(ThreadTerminalView.webAddress("vscode://file/x"))
        XCTAssertNil(ThreadTerminalView.webAddress("/Users/wayne/notes.md"))
    }

    // MARK: Paste

    func testPasteGetsPlainTextAndTheClipboardComesBack() {
        let board = NSPasteboard(name: .init("threadbear-terminal-paste-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        let item = NSPasteboardItem()
        item.setString("npm\u{00A0}run\u{200B} dev", forType: .string)
        item.setString("<b>npm run dev</b>", forType: .html)
        board.writeObjects([item])
        var pasted: String?
        ThreadTerminalView.cleaned(board) { pasted = board.string(forType: .string) }
        XCTAssertEqual(pasted, "npm run dev")
        XCTAssertEqual(board.string(forType: .string), "npm\u{00A0}run\u{200B} dev")
        XCTAssertEqual(board.string(forType: .html), "<b>npm run dev</b>")
    }

    /// A copy out of the transcript is plain text a shell takes as typed.
    func testTranscriptCopiesArePlain() {
        XCTAssertEqual(TranscriptTextView.plainCopy("the [tests pass]\u{2009}↑ and\u{00A0}npm\u{200B} test"), "the [tests pass] and npm test")
    }
}
