import AppKit
import SwiftUI
import SwiftTerm
import ThreadbearCore

/// The Terminal panel (⌘J, View > Show Terminal): a real terminal in the
/// dock, as VS Code and T3 Code have under their editor. SwiftTerm draws it
/// and runs your login shell in a pty, so colours, the cursor keys and
/// full-screen programs (vim, htop, claude) work as in Terminal.
///
/// Each thread has a shell of its own, started in the thread's folder (its
/// worktree when it has one) and kept running while you look at other
/// threads, so switching back finds it as you left it. A thread on another
/// Mac or the cloud gets a shell on this Mac in your home folder, with a
/// line saying so, as its folder isn't here. With no thread open it's a
/// shell in your home folder too.
///
/// A shell only starts when you ask for one: ⌘J, or clicking the empty
/// panel. Clicking through threads with the panel open, or launching with
/// it left open, starts nothing, as each login shell reads your whole
/// profile. A thread's shell stops when the thread is archived or deleted
/// (a dev server left running there would otherwise keep going in a
/// worktree the next thread gets), and every shell stops when the app quits.
@MainActor
@Observable
final class Terminals {
    static let shared = Terminals()

    /// Each target's shells, as tabs in the order they were opened.
    @ObservationIgnored private var sessions: [String: [TerminalSession]] = [:]
    @ObservationIgnored private var selected: [String: UUID] = [:]
    /// Bumped to ask the showing terminal to take the keyboard.
    private(set) var focusTick = 0

    /// Bumped when a shell starts or stops, so the panel redraws (the
    /// sessions themselves aren't observed).
    private(set) var generation = 0

    /// Where each target's tabs were left when the app last quit, and so
    /// where they come back (TerminalMemory).
    @ObservationIgnored let memory: TerminalMemory

    /// `memoryFile`: tests give a temporary one, never the data folder's.
    init(memoryFile: URL? = nil) {
        memory = TerminalMemory(file: memoryFile ?? RunnerConfig.dataDir().appendingPathComponent("terminals.json"))
    }
    /// The target's showing shell, if one has been started.
    func existing(for target: TerminalTarget) -> TerminalSession? {
        _ = generation
        guard let tabs = sessions[target.key], !tabs.isEmpty else { return nil }
        let current = tabs.first { $0.id == selected[target.key] } ?? tabs[tabs.count - 1]
        current.startIfNeeded()
        return current
    }

    /// The target's shells, as tabs.
    func tabs(for target: TerminalTarget) -> [TerminalSession] {
        _ = generation
        return sessions[target.key] ?? []
    }

    /// The target's shell, starting one if it has none, and gives it the
    /// keyboard: ⌘J and a click on the empty panel. Tabs left open when
    /// the app last quit come back here, in their folders, with what they
    /// showed; only the one showing starts its shell straight away.
    @discardableResult
    func open(_ target: TerminalTarget) -> TerminalSession {
        defer { focusTick += 1 }
        if let s = existing(for: target) { return s }
        if let saved = memory.take(target.key), !saved.tabs.isEmpty {
            let tabs = saved.tabs.enumerated().map { index, tab in
                TerminalSession(target: target, number: index + 1, restoring: tab)
            }
            sessions[target.key] = tabs
            let pick = tabs[min(max(saved.selected, 0), tabs.count - 1)]
            selected[target.key] = pick.id
            pick.startIfNeeded()
            generation += 1
            return pick
        }
        let s = TerminalSession(target: target, number: 1)
        s.startIfNeeded()
        sessions[target.key] = [s]
        selected[target.key] = s.id
        generation += 1
        return s
    }

    /// Another shell for the target, in a tab of its own, showing.
    @discardableResult
    func add(_ target: TerminalTarget) -> TerminalSession {
        let taken = Set((sessions[target.key] ?? []).map(\.number))
        let number = (1...).first { !taken.contains($0) } ?? 1
        // In the folder the showing tab is in now, as a new Terminal tab is.
        let cwd = existing(for: target)?.currentDirectory
        let s = TerminalSession(target: target, number: number, cwd: cwd)
        s.startIfNeeded()
        sessions[target.key, default: []].append(s)
        selected[target.key] = s.id
        generation += 1
        focusTick += 1
        return s
    }

    func select(_ id: UUID, in target: TerminalTarget) {
        guard sessions[target.key]?.contains(where: { $0.id == id }) == true else { return }
        selected[target.key] = id
        generation += 1
        focusTick += 1
    }

    /// Closes one tab and ends its shell. The last tab can't be closed
    /// here: ⌘J hides the panel, and the thread's archive stops it.
    func close(_ id: UUID, in key: String) {
        guard var tabs = sessions[key], tabs.count > 1, let index = tabs.firstIndex(where: { $0.id == id }) else { return }
        let s = tabs.remove(at: index)
        sessions[key] = tabs
        if selected[key] == id { selected[key] = tabs[min(index, tabs.count - 1)].id }
        s.stop()
        generation += 1
        focusTick += 1
    }

    /// A shell exited by itself (`exit`): one of several closes its tab, as
    /// Terminal's does; the last stays, with New Shell over it.
    fileprivate func exited(_ session: TerminalSession) {
        let key = session.target.key
        guard (sessions[key]?.count ?? 0) > 1 else { return }
        close(session.id, in: key)
    }

    /// Stops a thread's shells (the thread was archived or deleted), and
    /// forgets where they were.
    func stop(threadId: String) {
        memory.forget(threadId)
        guard let tabs = sessions.removeValue(forKey: threadId) else { return }
        selected[threadId] = nil
        tabs.forEach { $0.stop() }
        generation += 1
    }

    /// Called whenever the app's thread list changes: stops the shells of
    /// threads that have been archived. Threads missing from the list are
    /// left alone here, as the list can be briefly incomplete; a deleted
    /// thread's shell is stopped from `forget`, or from `stopAll(except:)`
    /// once the runner's full list comes back after a reconnect.
    func stopArchived(in threads: [String: ThreadSummary]) {
        for key in sessions.keys where threads[key]?.isArchived == true { stop(threadId: key) }
        memory.forget(where: { threads[$0]?.isArchived == true })
    }

    /// The runner's full thread list has come back (on connecting): any
    /// thread's shell not in it belongs to a thread deleted while the app
    /// wasn't listening, so it stops. The shared home shell stays.
    func stopAll(except threadIds: some Collection<String>) {
        let keep = Set(threadIds)
        for key in sessions.keys where key != "home" && !keep.contains(key) { stop(threadId: key) }
        memory.forget(where: { $0 != "home" && !keep.contains($0) })
    }

    /// A new shell in place of one that has exited, in the same tab.
    func restart(_ key: String) {
        guard var tabs = sessions[key], let index = tabs.firstIndex(where: { $0.id == selected[key] }) ?? tabs.indices.last else { return }
        let old = tabs[index]
        let fresh = TerminalSession(target: old.target, number: old.number, cwd: old.currentDirectory)
        fresh.name = old.name
        fresh.startIfNeeded()
        tabs[index] = fresh
        sessions[key] = tabs
        selected[key] = fresh.id
        old.stop()
        generation += 1
        focusTick += 1
    }

    /// When the app quits: every tab's folder, name and what it showed, for
    /// next time.
    func saveForNextLaunch() {
        for (key, tabs) in sessions where !tabs.isEmpty {
            let pick = tabs.firstIndex { $0.id == selected[key] } ?? tabs.count - 1
            memory.remember(key, TerminalMemory.Saved(tabs: tabs.map { $0.snapshot() }, selected: pick))
        }
        memory.save()
    }

    /// For the automation and `dump`: what's running where.
    var debugSummary: [String] {
        sessions.keys.sorted().flatMap { key in
            (sessions[key] ?? []).map { "\(key) \($0.title(fallback: "Terminal \($0.number)")) \($0.exited ? "exited" : $0.started ? "running" : "waiting") in \($0.currentDirectory ?? $0.target.cwd)" }
        }
    }
}

/// Where a terminal runs: its key (the thread, or "home") and folder.
struct TerminalTarget: Equatable {
    var key: String
    var cwd: String
    /// Said above the terminal when its folder isn't the thread's.
    var note: String?

    @MainActor
    static func `for`(_ thread: ThreadSummary?, runnerName: (ThreadSummary) -> String?) -> TerminalTarget {
        let home = NSHomeDirectory()
        guard let thread else { return TerminalTarget(key: "home", cwd: home) }
        // An archived thread's worktree may have been handed to a newer
        // thread since (archive keeps it as a spare), so its folder could be
        // someone else's checkout now. Its own shell was stopped on archive.
        if thread.isArchived {
            return TerminalTarget(key: "home", cwd: home, note: "This thread is archived, so this terminal is in your home folder.")
        }
        if thread.isRemote {
            let where_ = runnerName(thread).map { "on \($0)" } ?? "on another machine"
            return TerminalTarget(key: "home", cwd: home, note: "This thread runs \(where_), so this terminal is on this Mac, in your home folder.")
        }
        var isDir: ObjCBool = false
        guard !thread.cwd.isEmpty, FileManager.default.fileExists(atPath: thread.cwd, isDirectory: &isDir), isDir.boolValue else {
            return TerminalTarget(key: "home", cwd: home, note: "This thread's folder isn't on this Mac any more, so this terminal is in your home folder.")
        }
        return TerminalTarget(key: thread.id, cwd: thread.cwd)
    }
}

/// One shell in one pty, and the view that draws it: one tab of a
/// thread's terminal.
@MainActor
@Observable
final class TerminalSession: NSObject, LocalProcessTerminalViewDelegate {
    let id = UUID()
    let target: TerminalTarget
    /// Its place among the target's tabs, for the name it has until the
    /// shell gives it one ("Terminal 2").
    let number: Int
    /// A name of his own (double-click the tab, or Rename…).
    var name: String?
    @ObservationIgnored let view: ThreadTerminalView
    private(set) var exited = false
    private(set) var title = ""
    @ObservationIgnored private(set) var started = false
    @ObservationIgnored private let startIn: String

    init(target: TerminalTarget, number: Int = 1, cwd: String? = nil, restoring saved: TerminalMemory.Tab? = nil) {
        self.target = target
        self.number = number
        self.name = saved?.name
        // A folder it was in last time, or the showing tab's, if it's still there.
        let wanted = saved?.cwd ?? cwd
        var isDir: ObjCBool = false
        if let wanted, FileManager.default.fileExists(atPath: wanted, isDirectory: &isDir), isDir.boolValue {
            startIn = wanted
        } else {
            startIn = target.cwd
        }
        view = ThreadTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 240))
        super.init()
        view.processDelegate = self
        view.font = TerminalStyle.font
        TerminalStyle.apply(to: view)
        if let saved, !saved.screen.isEmpty {
            // What it showed when the app quit, above the new prompt.
            view.feed(text: saved.screen.joined(separator: "\r\n") + "\r\n\u{1B}[2m[Restored from the last time Threadbear was open]\u{1B}[0m\r\n")
        }
    }

    /// Starts the shell, once: when the tab is first shown.
    func startIfNeeded() {
        guard !started else { return }
        started = true
        start()
    }

    private func start() {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        // A login shell ("-zsh" as its name), so it reads your profile and
        // has the PATH Terminal gives you, which an app's own doesn't.
        let name = "-" + (shell as NSString).lastPathComponent
        view.startProcess(executable: shell, args: [], environment: Self.environment(), execName: name, currentDirectory: startIn)
    }

    /// The tab's name: his own, else the shell's title, else `fallback`.
    func title(fallback: String) -> String {
        if let name, !name.isEmpty { return name }
        let own = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return own.isEmpty ? fallback : own
    }

    /// The folder the shell is in now (asked of the system, as a shell
    /// only says when it's set up to), or where it started.
    var currentDirectory: String? {
        guard started, !exited, let pid = view.process?.shellPid, pid > 0 else { return started ? nil : startIn }
        return TerminalMemory.directory(of: pid) ?? startIn
    }

    /// What to keep of this tab for next time.
    func snapshot() -> TerminalMemory.Tab {
        TerminalMemory.Tab(name: name, cwd: currentDirectory ?? startIn, screen: started ? view.screenText(lastLines: TerminalMemory.linesKept) : [])
    }

    static func environment(from base: [String: String] = ProcessInfo.processInfo.environment) -> [String] {
        var env = base
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Threadbear"
        if (env["LANG"] ?? "").isEmpty { env["LANG"] = "en_US.UTF-8" }
        // Never a thread id: the runner reads it as "this is that thread's
        // own agent" (runner/src/cli.ts), so `tb` typed here would refuse to
        // archive the thread with a message meant for agents, and log what
        // you do as the agent's doing. The app may have inherited either
        // name if it was started from inside a thread.
        env.removeValue(forKey: "THREADBEAR_THREAD_ID")
        env.removeValue(forKey: "THREADBARE_THREAD_ID")
        env.removeValue(forKey: "THREADBEAR_THREAD_KEY")
        return env.map { "\($0.key)=\($0.value)" }
    }

    /// Ends the shell as closing a Terminal window does: SIGHUP, which an
    /// interactive shell passes on to its jobs (SIGTERM, LocalProcess's
    /// own terminate, is ignored by an interactive zsh). If it's still
    /// there once the session is let go, LocalProcess's deinit kills it.
    func stop() {
        let pid = view.process?.shellPid ?? 0
        if pid > 0, !exited { kill(pid, SIGHUP) }
        view.removeFromSuperview()
    }

    /// Text typed into the shell, for the automation.
    func type(_ text: String) {
        view.send(txt: text)
    }

    // MARK: LocalProcessTerminalViewDelegate

    nonisolated func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}

    nonisolated func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        MainActor.assumeIsolated { self.title = title }
    }

    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    nonisolated func processTerminated(source: TerminalView, exitCode: Int32?) {
        MainActor.assumeIsolated {
            self.exited = true
            Terminals.shared.exited(self)
        }
    }
}

/// The terminal's font and colours: the app's code font, on the transcript's
/// own background, light or dark with the app.
enum TerminalStyle {
    @MainActor static var font: NSFont { .monospacedSystemFont(ofSize: Theme.codeSize + 1, weight: .regular) }

    @MainActor
    static func apply(to view: TerminalView) {
        let dark = view.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        view.nativeBackgroundColor = dark ? NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1) : NSColor(white: 1, alpha: 1)
        view.nativeForegroundColor = dark ? NSColor(white: 0.9, alpha: 1) : NSColor(white: 0.12, alpha: 1)
        view.caretColor = .controlAccentColor
        view.selectedTextBackgroundColor = NSColor.selectedTextBackgroundColor
    }
}

struct TerminalPanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let target = TerminalTarget.for(app.selectedThread) { app.runnerName(of: $0) }
        let session = Terminals.shared.existing(for: target)
        VStack(spacing: 0) {
            if let note = target.note {
                Text(note)
                    .font(.system(size: TypeScale.detail))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, zoomed(10))
                    .padding(.vertical, zoomed(5))
                    .tip(note)
            }
            if let session {
                TerminalTabStrip(target: target, tabs: Terminals.shared.tabs(for: target), current: session.id)
                Divider()
                ZStack(alignment: .bottom) {
                    TerminalHost(session: session, focusTick: Terminals.shared.focusTick)
                        .dockDragDisabled()
                    if session.exited {
                    HStack(spacing: zoomed(8)) {
                        Text("The shell has exited.").foregroundStyle(.secondary)
                        Button("New Shell") { Terminals.shared.restart(target.key) }
                            .tip("Start a new shell in \((target.cwd as NSString).abbreviatingWithTildeInPath)")
                    }
                    .font(.system(size: TypeScale.label))
                    .padding(zoomed(8))
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding(zoomed(10))
                    }
                }
            } else {
                // No shell for this thread yet: one starts on a click here
                // or ⌘J, not just from looking.
                Button { Terminals.shared.open(target) } label: {
                    Label("Start a shell", systemImage: WindowDock.terminalSymbol)
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .tip("Start your login shell in \((target.cwd as NSString).abbreviatingWithTildeInPath)")
            }
        }
    }
}

/// The tabs above the terminal: one per shell, + for another, ✕ to close
/// one. Double-click a tab, or Rename… in its right-click menu, to name it.
private struct TerminalTabStrip: View {
    let target: TerminalTarget
    let tabs: [TerminalSession]
    let current: UUID

    var body: some View {
        HStack(spacing: zoomed(2)) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: zoomed(2)) {
                    ForEach(tabs, id: \.id) { tab in
                        TerminalTabButton(
                            tab: tab, selected: tab.id == current, closable: tabs.count > 1,
                            select: { Terminals.shared.select(tab.id, in: target) },
                            close: { Terminals.shared.close(tab.id, in: target.key) }
                        )
                    }
                    Button { Terminals.shared.add(target) } label: { Image(systemName: "plus") }
                        .buttonStyle(RowIconButtonStyle())
                        .tip("Open another terminal, in the folder this one is in")
                        .accessibilityLabel("New terminal")
                }
                .padding(.horizontal, zoomed(6))
            }
        }
        .frame(height: zoomed(30))
    }
}

private struct TerminalTabButton: View {
    let tab: TerminalSession
    let selected: Bool
    let closable: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var hovering = false
    @State private var renaming = false
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool

    private var title: String { tab.title(fallback: "Terminal \(tab.number)") }

    var body: some View {
        HStack(spacing: zoomed(4)) {
            if renaming {
                TextField("Name", text: $draft)
                    .textFieldStyle(.plain)
                    .font(.system(size: TypeScale.label, weight: .medium))
                    .frame(width: zoomed(120))
                    .focused($fieldFocused)
                    .onSubmit(commit)
                    .onExitCommand { renaming = false }
                    .onChange(of: fieldFocused) { _, focused in if !focused && renaming { commit() } }
                    .tip("Return keeps the name and Escape leaves it as it was. An empty name goes back to the shell's own")
            } else {
                Text(title)
                    .font(.system(size: TypeScale.label, weight: selected ? .medium : .regular))
                    .foregroundStyle(selected ? .primary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: zoomed(160), alignment: .leading)
            }
            if closable {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: zoomed(8.5), weight: .semibold))
                        .frame(width: zoomed(14), height: zoomed(14))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .opacity(hovering || selected ? 1 : 0)
                .tip("Close this terminal and end its shell")
                .accessibilityLabel("Close \(title)")
            }
        }
        .padding(.leading, zoomed(8))
        .padding(.trailing, zoomed(closable ? 4 : 8))
        .frame(height: zoomed(22))
        .background(
            Color.primary.opacity(selected ? 0.1 : hovering ? 0.05 : 0),
            in: RoundedRectangle(cornerRadius: zoomed(5))
        )
        .contentShape(Rectangle())
        // Both at once, so a click picks the tab straight away rather than
        // waiting to see whether a second click is coming.
        .onTapGesture(perform: select)
        .simultaneousGesture(TapGesture(count: 2).onEnded { startRenaming() })
        .onHover { hovering = $0 }
        .iconContextMenu {
            Button("Rename…", systemImage: "pencil", action: startRenaming)
            if tab.name != nil { Button("Use the Shell's Name", systemImage: "arrow.uturn.backward") { tab.name = nil } }
            if closable {
                Divider()
                Button("Close Terminal", systemImage: "xmark", action: close)
            }
        }
        .tip(tab.exited ? "This shell has ended" : "\(title). Double-click to rename it")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: "Rename") { startRenaming() }
        .accessibilityAction(named: "Close") { if closable { close() } }
    }

    private func startRenaming() {
        select()
        draft = title
        renaming = true
        DispatchQueue.main.async { fieldFocused = true }
    }

    private func commit() {
        guard renaming else { return }
        renaming = false
        let name = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        tab.name = name.isEmpty ? nil : String(name.prefix(60))
    }
}

/// Hosts the session's view, swapping it when the thread changes, and
/// gives it the keyboard when asked (⌘J).
private struct TerminalHost: NSViewRepresentable {
    let session: TerminalSession
    let focusTick: Int

    /// Holds the terminal a little in from the panel's edges, on the
    /// terminal's own background.
    final class Container: NSView {
        var focusTick = 0
        static var inset: NSSize { NSSize(width: zoomed(10), height: zoomed(6)) }

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
        }

        required init?(coder: NSCoder) { fatalError() }

        override func layout() {
            super.layout()
            let inset = Self.inset
            for view in subviews { view.frame = bounds.insetBy(dx: inset.width, dy: inset.height) }
        }

        override func viewDidChangeEffectiveAppearance() {
            super.viewDidChangeEffectiveAppearance()
            for case let view as TerminalView in subviews {
                TerminalStyle.apply(to: view)
                layer?.backgroundColor = view.nativeBackgroundColor.cgColor
            }
        }
    }

    func makeNSView(context: Context) -> Container {
        let c = Container()
        c.focusTick = focusTick - 1
        return c
    }

    func updateNSView(_ container: Container, context: Context) {
        let view = session.view
        if view.superview !== container {
            container.subviews.forEach { $0.removeFromSuperview() }
            view.removeFromSuperview()
            view.autoresizingMask = []
            container.addSubview(view)
            container.needsLayout = true
            TerminalStyle.apply(to: view)
            container.layer?.backgroundColor = view.nativeBackgroundColor.cgColor
        }
        let font = TerminalStyle.font
        if view.font.pointSize != font.pointSize { view.font = font }
        if container.focusTick != focusTick {
            container.focusTick = focusTick
            DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        }
    }

    static func dismantleNSView(_ container: Container, coordinator: ()) {
        // The session keeps the view (and its shell) for next time.
        container.subviews.forEach { $0.removeFromSuperview() }
    }
}
