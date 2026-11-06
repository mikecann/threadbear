import AppKit
import SwiftTerm
import SwiftUI
import ThreadbearCore

/// The rail's built-in Files and Terminal (below the folder's own panels,
/// such as Worktrees): the thread's folder to look through, and a shell in it.
enum BuiltinPanels {
    static let files = "threadbear.files"
    static let terminal = "threadbear.terminal"
}

/// A real terminal (SwiftTerm) for the thread, running his login shell in
/// the thread's folder, as Terminal.app would: his PATH, nvm and aliases,
/// colours, and anything full-screen (vim, top). One per thread, kept for
/// as long as the app runs, so moving to another thread and back finds it
/// as it was; a shell that exits starts again on the next look. Only for
/// threads on this Mac: another Mac's folder isn't here to run a shell in.
struct TerminalPanel: NSViewRepresentable {
    let thread: ThreadSummary

    func makeNSView(context: Context) -> NSView {
        let box = NSView()
        box.wantsLayer = true
        attach(to: box)
        return box
    }

    func updateNSView(_ box: NSView, context: Context) {
        attach(to: box)
    }

    private func attach(to box: NSView) {
        let term = TerminalSessions.shared.view(for: thread)
        guard term.superview !== box else { return }
        box.subviews.forEach { $0.removeFromSuperview() }
        term.removeFromSuperview()
        term.frame = box.bounds
        term.autoresizingMask = [.width, .height]
        box.addSubview(term)
        DispatchQueue.main.async { term.window?.makeFirstResponder(term) }
    }
}

@MainActor
final class TerminalSessions: NSObject, LocalProcessTerminalViewDelegate {
    static let shared = TerminalSessions()
    private var views: [String: LocalProcessTerminalView] = [:]
    private var ended: Set<ObjectIdentifier> = []

    func view(for thread: ThreadSummary) -> LocalProcessTerminalView {
        if let view = views[thread.id], !ended.contains(ObjectIdentifier(view)) { return view }
        let view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        view.processDelegate = self
        view.font = .monospacedSystemFont(ofSize: TypeScale.scaled(12), weight: .regular)
        view.nativeBackgroundColor = .textBackgroundColor
        view.nativeForegroundColor = .textColor
        view.caretColor = .controlAccentColor
        view.setAccessibilityLabel("Terminal for \(thread.title)")
        let shell = Self.shell
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Threadbear"
        // So the thread's own variables (THREADBEAR_THREAD_ID and the like) don't leak in.
        for key in env.keys where key.hasPrefix("THREADBEAR_") || key.hasPrefix("CLAUDE") { env[key] = nil }
        let cwd = (thread.cwd as NSString).expandingTildeInPath
        view.startProcess(executable: shell, args: ["-l"], environment: env.map { "\($0.key)=\($0.value)" },
                          execName: "-" + (shell as NSString).lastPathComponent,
                          currentDirectory: FileManager.default.fileExists(atPath: cwd) ? cwd : NSHomeDirectory())
        if let old = views[thread.id] { ended.remove(ObjectIdentifier(old)) }
        views[thread.id] = view
        return view
    }

    /// His login shell, as Terminal.app uses.
    static var shell: String {
        if let own = ProcessInfo.processInfo.environment["SHELL"], FileManager.default.isExecutableFile(atPath: own) { return own }
        return "/bin/zsh"
    }

    /// Every shell, when the app quits.
    func endAll() {
        for view in views.values { view.process.terminate() }
        views = [:]
    }

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        // `exit` in the shell: a fresh one the next time the panel's looked at.
        MainActor.assumeIsolated {
            ended.insert(ObjectIdentifier(source))
            source.feed(text: "\r\n[The shell ended. Open Terminal again for a new one.]\r\n")
        }
    }
}
