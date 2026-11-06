import AppKit
import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// Settings > General > Files > Edit files like an editor (on by default):
/// a text file opens ready to type in. With Save files automatically (on
/// by default) typing is written a second after it stops; off, it waits
/// for ⌘S, and leaving with changes asks. With the editor off, it's saved
/// as you type.
@MainActor
final class FileEditorModeTests: XCTestCase {
    private var file: URL!

    override func setUp() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("editor-mode-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        file = dir.appendingPathComponent("hello.ts")
        try "let a = 1;\n".write(to: file, atomically: true, encoding: .utf8)
    }

    override func tearDown() async throws {
        UserDefaults.standard.removeObject(forKey: FileEditorMode.key)
        UserDefaults.standard.removeObject(forKey: FileAutosave.key)
        EditedFiles.shared.scriptedAnswer = nil
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    private func onDisk() -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }

    private func editor(mode: Bool, autosave: Bool = true) -> (TextFileController, NSWindow) {
        UserDefaults.standard.set(mode, forKey: FileEditorMode.key)
        UserDefaults.standard.set(autosave, forKey: FileAutosave.key)
        let controller = TextFileController(url: file)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = controller.scroll
        controller.start(editing: true, dark: false)
        window.makeFirstResponder(controller.textView)
        return (controller, window)
    }

    func testBothSettingsAreOnUntilTurnedOff() {
        UserDefaults.standard.removeObject(forKey: FileEditorMode.key)
        UserDefaults.standard.removeObject(forKey: FileAutosave.key)
        XCTAssertTrue(FileEditorMode.isOn)
        XCTAssertTrue(FileAutosave.isOn)
    }

    func testAutosaveWritesASecondAfterTyping() {
        let (controller, window) = editor(mode: true)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("let b = 2;\n")
        XCTAssertTrue(controller.dirty)
        XCTAssertTrue(EditedFiles.shared.isUnsaved(file.path), "the pane's title marks it")
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(onDisk(), "let a = 1;\n", "not while typing")
        RunLoop.main.run(until: Date().addingTimeInterval(0.9))
        XCTAssertEqual(onDisk(), "let a = 1;\nlet b = 2;\n")
        XCTAssertFalse(controller.dirty)
        XCTAssertFalse(EditedFiles.shared.isUnsaved(file.path))
        XCTAssertTrue(controller.justSaved, "the quiet Saved tick")
    }

    func testTypingWaitsForCommandS() throws {
        let (controller, window) = editor(mode: true, autosave: false)
        defer { controller.stop(); window.close() }
        XCTAssertTrue(controller.textView.isEditable)
        XCTAssertTrue(controller.scroll.rulersVisible, "line numbers while editing")
        controller.insertAtEnd("let b = 2;\n")
        XCTAssertTrue(controller.dirty)
        // Well past the save-as-you-type delay: still not written.
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        XCTAssertEqual(onDisk(), "let a = 1;\n")

        let commandS = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                                                      windowNumber: window.windowNumber, context: nil, characters: "s",
                                                      charactersIgnoringModifiers: "s", isARepeat: false, keyCode: 1))
        XCTAssertTrue(window.performKeyEquivalent(with: commandS))
        XCTAssertEqual(onDisk(), "let a = 1;\nlet b = 2;\n")
        XCTAssertFalse(controller.dirty)
    }

    func testLeavingWithAutosaveOffAsks() {
        let (controller, window) = editor(mode: true, autosave: false)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("// more\n")
        let files = EditedFiles.shared

        files.scriptedAnswer = .cancel
        XCTAssertFalse(files.mayLeave(file.path), "Cancel stays")
        XCTAssertEqual(files.lastAsked, file.path)
        XCTAssertEqual(onDisk(), "let a = 1;\n")

        files.scriptedAnswer = .save
        XCTAssertTrue(files.mayLeave(file.path))
        XCTAssertEqual(onDisk(), "let a = 1;\n// more\n")
    }

    func testDontSaveLeavesTheFileAsItWas() {
        let (controller, window) = editor(mode: true, autosave: false)
        defer { window.close() }
        controller.insertAtEnd("// gone\n")
        EditedFiles.shared.scriptedAnswer = .discard
        XCTAssertTrue(EditedFiles.shared.mayLeave(file.path))
        controller.stop()
        XCTAssertEqual(onDisk(), "let a = 1;\n")
        XCTAssertFalse(EditedFiles.shared.isUnsaved(file.path))
    }

    /// An agent rewrites the file just before a save: it isn't written over.
    func testAnOutsideChangeIsntWrittenOver() {
        let (controller, window) = editor(mode: true, autosave: false)
        defer { controller.stop(); window.close() }
        controller.insertAtEnd("// mine\n")
        try? "let a = 99;\n".write(to: file, atomically: false, encoding: .utf8)
        controller.saveNow()
        XCTAssertEqual(onDisk(), "let a = 99;\n")
        XCTAssertEqual(controller.conflict, "let a = 99;\n", "the bar asks")
        controller.keepMine()
        XCTAssertEqual(onDisk(), "let a = 1;\n// mine\n")
        XCTAssertNil(controller.conflict)
    }

    func testLeavingTheFileSavesIt() {
        let (controller, window) = editor(mode: true, autosave: false)
        defer { window.close() }
        controller.insertAtEnd("// more\n")
        controller.stop()
        XCTAssertEqual(onDisk(), "let a = 1;\n// more\n")
    }

    func testCursorPositionForTheStatusBar() {
        let (controller, window) = editor(mode: true)
        defer { controller.stop(); window.close() }
        controller.textView.setSelectedRange(NSRange(location: 4, length: 0))
        XCTAssertEqual(controller.cursor.line, 1)
        XCTAssertEqual(controller.cursor.column, 5)
        controller.insertAtEnd("x")
        XCTAssertEqual(controller.cursor.line, 2)
        XCTAssertEqual(controller.cursor.column, 2)
    }

    func testOffItSavesAsYouType() {
        let (controller, window) = editor(mode: false)
        defer { controller.stop(); window.close() }
        XCTAssertFalse(controller.scroll.hasVerticalRuler)
        controller.insertAtEnd("let c = 3;\n")
        XCTAssertTrue(controller.dirty, "marked until the save lands")
        RunLoop.main.run(until: Date().addingTimeInterval(1.2))
        XCTAssertEqual(onDisk(), "let a = 1;\nlet c = 3;\n")
        XCTAssertFalse(controller.dirty)
    }
}
