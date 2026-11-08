import AppKit
import Observation
import SwiftUI
import ThreadbearCore

/// Voice's keyboard shortcuts at work (VoiceKeyMonitor works out which):
/// hold Fn to dictate into whatever text box has the cursor and let go to
/// type it in, Fn Space (or two taps of Fn) for hands-free dictation that
/// types in at each pause, and Fn Control for Command Mode, where what's
/// said goes to the open thread as a message. Speech is turned into text
/// on this Mac by macOS, as for Notes, and nothing is spoken back. One
/// microphone user at a time: it won't start while Voice or a note is
/// listening, and either of those starting ends it.
@MainActor
@Observable
final class KeyDictation {
    static let shared = KeyDictation()

    enum Phase: Equatable {
        case off
        case starting(String)
        case listening
        /// The words so far, not typed in or sent yet.
        case hearing(String)
        /// Let go: the last words are coming in.
        case finishing
        case failed(String)
    }

    private(set) var phase: Phase = .off { didSet { KeyDictationHUD.shared.sync() } }
    private(set) var mode: VoiceKeyMachine.Mode = .idle
    /// 0...1, his voice, for the bars.
    private(set) var level: Float = 0

    /// The monitor's machine goes back to idle when this stops by itself.
    @ObservationIgnored var onEnded: (() -> Void)?
    @ObservationIgnored private var audio: VoiceAudio?
    @ObservationIgnored private var tracker = UtteranceTracker(pause: 0.8)
    @ObservationIgnored private var endpointTimer: Timer?
    @ObservationIgnored private var startId = UUID()
    /// The text box that had the cursor when it started.
    @ObservationIgnored private weak var target: NSTextView?
    /// Waiting for the words heard so far before the microphone stops.
    static let finishGrace = 0.4

    var isOn: Bool {
        switch phase {
        case .off, .failed: false
        default: true
        }
    }

    /// Starts listening for `mode`, or switches what's listening to it
    /// (Space during a hold carries on hands-free).
    func start(_ mode: VoiceKeyMachine.Mode) {
        if isOn, phase != .finishing {
            self.mode = mode
            return
        }
        guard VoiceMode.enabled, !VoiceMode.shared.isOn, !NoteDictation.shared.isOn else {
            onEnded?()
            return
        }
        stopAudio()
        let startId = UUID()
        self.startId = startId
        self.mode = mode
        tracker = UtteranceTracker(pause: 0.8)
        target = Self.focusedTextView()
        // No text box with the cursor: the open thread's message box.
        if target == nil, mode != .command {
            let app = AppModel.shared
            app.focusComposer(app.selection ?? VoiceMode.newThread)
        }
        phase = .starting("Asking for the microphone…")
        let defaults = UserDefaults.standard
        let language = VoiceCatalog.language(defaults.string(forKey: VoiceCatalog.languageKey))
        let mic = VoiceAudio.microphone(uid: defaults.string(forKey: VoiceCatalog.microphoneKey))
        let audio = VoiceAudio()
        audio.onResult = { [weak self] in self?.heard($0) }
        audio.onInputLevel = { [weak self] level in self?.show(level: level) }
        self.audio = audio
        Task {
            do {
                try await audio.start(locale: Locale(identifier: language.locale), microphone: mic, echoCancellation: false)
                guard self.startId == startId else { audio.stop(); return }
                if self.phase != .finishing { self.phase = .listening }
                self.endpointTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.checkPause() }
                }
                VoiceLog.write("dictating from the keyboard")
            } catch {
                guard self.startId == startId else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    /// Let go, or hands-free stopped: what was said goes in, or to the
    /// thread, once the recogniser has caught up with the last words.
    func finish() {
        guard isOn, phase != .finishing else { return }
        let startId = self.startId
        phase = .finishing
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.finishGrace) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.startId == startId else { return }
                let text = self.tracker.flush()
                let mode = self.mode
                self.end()
                if let text { self.deliver(text, mode: mode) }
            }
        }
    }

    /// Esc: nothing typed in or sent.
    func cancel() {
        guard isOn || audio != nil else { dismissFailure(); return }
        VoiceLog.write("keyboard dictation cancelled")
        end()
        onEnded?()
    }

    func dismissFailure() {
        if case .failed = phase { phase = .off }
    }

    private func end() {
        startId = UUID()
        stopAudio()
        tracker = UtteranceTracker(pause: 0.8)
        level = 0
        mode = .idle
        phase = .off
    }

    private func stopAudio() {
        endpointTimer?.invalidate()
        endpointTimer = nil
        audio?.stop()
        audio = nil
    }

    private func fail(_ message: String) {
        VoiceLog.write("keyboard dictation failed: \(message)")
        end()
        phase = .failed(message)
        onEnded?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            MainActor.assumeIsolated { self?.dismissFailure() }
        }
    }

    private func show(level new: Float) {
        let rounded = (new * 10).rounded() / 10
        if rounded != level { level = rounded }
    }

    private func heard(_ result: UtteranceTracker.Result) {
        guard isOn else { return }
        if tracker.add(result, now: CACurrentMediaTime()), phase != .finishing { phase = .hearing(tracker.pending) }
    }

    /// Hands-free types in at each pause; a hold waits for the release.
    private func checkPause() {
        guard mode == .handsFree, phase != .finishing, let text = tracker.take(now: CACurrentMediaTime()) else { return }
        type(text)
        phase = .listening
    }

    private func deliver(_ text: String, mode: VoiceKeyMachine.Mode) {
        guard mode == .command else { type(text); return }
        let app = AppModel.shared
        if let threadId = app.selection, app.threads[threadId] != nil {
            app.sendSpoken(threadId: threadId, text: text)
        } else {
            app.startThreadSpoken(text) { _ in }
        }
        VoiceLog.write("sent a Command Mode message")
    }

    /// Typed in at the cursor (over a selection), as if he'd typed it, as
    /// NoteDictation does: it saves and undoes as typing does.
    private func type(_ words: String) {
        guard let view = target.flatMap({ $0.window == nil ? nil : $0 }) ?? Self.focusedTextView() else {
            fail("There was no text box to type into. Click into one, then try again.")
            return
        }
        let string = view.string as NSString
        let range = view.selectedRange()
        let before = range.location > 0 ? Character(string.substring(with: string.rangeOfComposedCharacterSequence(at: range.location - 1))) : nil
        let end = NSMaxRange(range)
        let after = end < string.length ? Character(string.substring(with: string.rangeOfComposedCharacterSequence(at: end))) : nil
        guard let text = DictatedText.insertion(words, before: before, after: after) else { return }
        view.insertText(text, replacementRange: range)
        view.scrollRangeToVisible(view.selectedRange())
    }

    /// The editable text view with the cursor in the key window, if any.
    static func focusedTextView() -> NSTextView? {
        guard let view = (NSApp.keyWindow ?? NSApp.mainWindow)?.firstResponder as? NSTextView, view.isEditable else { return nil }
        return view
    }

    #if DEBUG
    /// The automation hook: a phase to look at, nothing listening.
    func stage(_ phase: Phase, mode: VoiceKeyMachine.Mode, level: Float) {
        self.mode = mode
        self.level = level
        self.phase = phase
    }
    #endif
}

/// A small pill over the bottom of the window while Fn dictation is on:
/// what it's doing, the words so far, and how to finish or cancel. A
/// panel of its own, so it shows over a note, Settings or a thread alike,
/// and takes no clicks.
@MainActor
final class KeyDictationHUD {
    static let shared = KeyDictationHUD()
    private var panel: NSPanel?

    func sync() {
        if KeyDictation.shared.phase == .off {
            panel?.orderOut(nil)
            return
        }
        let panel = self.panel ?? make()
        self.panel = panel
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }), window !== panel else { return }
        if !panel.isVisible {
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: window.frame.midX - size.width / 2, y: window.frame.minY + 72))
            panel.orderFront(nil)
        }
    }

    private func make() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 460, height: 52), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        let host = NSHostingView(rootView: KeyDictationPill())
        host.frame = panel.contentRect(forFrameRect: panel.frame)
        host.autoresizingMask = [.width, .height]
        panel.contentView = host
        return panel
    }
}

private struct KeyDictationPill: View {
    @State private var dictation = KeyDictation.shared

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().fill(failed ? Color.orange : Color.red)
                if failed {
                    Image(systemName: "exclamationmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                } else {
                    VoiceBars(level: CGFloat(dictation.level), active: true, busy: busy)
                        .frame(width: 12, height: 12)
                }
            }
            .frame(width: 24, height: 24)
            Text(line)
                .font(.system(size: 12))
                .foregroundStyle(heard ? .primary : .secondary)
                .lineLimit(1)
                .truncationMode(heard ? .head : .tail)
        }
        .padding(.leading, 6)
        .padding(.trailing, 14)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(line)
    }

    private var failed: Bool {
        if case .failed = dictation.phase { return true }
        return false
    }

    private var busy: Bool {
        switch dictation.phase {
        case .starting, .finishing: true
        default: false
        }
    }

    private var heard: Bool {
        if case .hearing = dictation.phase { return true }
        return false
    }

    private var line: String {
        let keys = VoiceKeys(defaults: .standard)
        let key = keys.trigger.display
        switch dictation.phase {
        case .off: return ""
        case .starting(let status): return status
        case .finishing: return dictation.mode == .command ? "Sending…" : "Typing it in…"
        case .failed(let message): return message
        case .hearing(let words): return words
        case .listening:
            switch dictation.mode {
            case .command: return "Command Mode: let go of \(key) to send it to the thread. Esc cancels."
            case .handsFree: return "Hands-free: \(keys.shiftToggle ? keys.shiftDisplay : keys.handsFreeWithSpace ? keys.handsFreeDisplay : "tap \(key)") to stop, Esc to cancel"
            case .dictating, .idle: return "Listening: let go of \(key) to type it in. Esc cancels."
            }
        }
    }
}
