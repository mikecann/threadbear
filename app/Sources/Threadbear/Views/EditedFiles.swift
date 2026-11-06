import AppKit
import Observation

/// Settings > General > Files > Save files automatically (on until it's
/// turned off): a file being edited in the panel is written about a second
/// after the typing stops, and when you leave it. Off, it waits for ⌘S or
/// Save, and leaving it with changes asks first.
enum FileAutosave {
    static let key = "filesSaveAutomatically"
    static var isOn: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
}

/// The files open in the panel's editor and which have changes not in the
/// file yet: the pane's title marks those, and leaving one (Back, another
/// file or thread, closing the panel, quitting) saves it or asks first.
@MainActor
@Observable
final class EditedFiles {
    static let shared = EditedFiles()

    /// Paths with typing that isn't in the file yet.
    private(set) var unsaved: Set<String> = []
    @ObservationIgnored private let editors = NSHashTable<TextFileController>.weakObjects()

    /// What leaving a file with unsaved changes does, when autosave is off.
    enum Answer: String { case save, discard, cancel }
    /// The automation's answer, given instead of asking (a scripted app
    /// can't click an alert).
    @ObservationIgnored var scriptedAnswer: Answer?
    /// The last file asked about, for the automation.
    @ObservationIgnored var lastAsked: String?

    func register(_ editor: TextFileController) { editors.add(editor) }

    func setUnsaved(_ path: String, _ isUnsaved: Bool) {
        if isUnsaved { unsaved.insert(path) } else { unsaved.remove(path) }
    }

    func isUnsaved(_ path: String) -> Bool { unsaved.contains(path) }

    /// Before leaving the file at `path` (or every open one, for nil):
    /// with autosave on, it's saved; with it off and changes typed, Save,
    /// Don't Save or Cancel. False when the leaving should stop.
    func mayLeave(_ path: String?) -> Bool {
        let leaving = editors.allObjects.filter { path == nil || $0.url.path == path }
        for editor in leaving where editor.dirty {
            if editor.autosaves {
                editor.saveNow()
                continue
            }
            switch ask(about: editor.url) {
            case .save: editor.saveNow()
            case .discard: editor.discard()
            case .cancel: return false
            }
        }
        return true
    }

    private func ask(about url: URL) -> Answer {
        lastAsked = url.path
        if let scriptedAnswer { return scriptedAnswer }
        let alert = NSAlert()
        alert.messageText = "Save the changes to \(url.lastPathComponent)?"
        alert.informativeText = "If you don't save them, what you typed is lost."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        let dontSave = alert.addButton(withTitle: "Don't Save")
        dontSave.hasDestructiveAction = true
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .save
        case .alertThirdButtonReturn: return .discard
        default: return .cancel
        }
    }
}
