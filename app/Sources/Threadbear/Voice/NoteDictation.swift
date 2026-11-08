import AppKit
import Observation
import ThreadbearCore

/// Talking into a note: Voice's listening half on its own. What Mike says
/// is turned into text on this Mac by macOS (VoiceAudio's SpeechAnalyzer)
/// and typed in at the cursor each time he pauses, so a note's words still
/// never leave the Mac. Nothing is spoken back, so pocket-tts isn't
/// needed and nothing downloads for it. One microphone user at a time:
/// starting this ends Voice on a thread, and starting Voice ends this.
@MainActor
@Observable
final class NoteDictation {
    static let shared = NoteDictation()

    /// Settings > Voice & Audio's Use with Notes. Off by default: the microphone
    /// button in Notes only shows once he's asked for it.
    static let enabledKey = "voiceInNotes"
    /// Use Voice is on, and so is Use with Notes.
    static var enabled: Bool {
        VoiceMode.enabled && UserDefaults.standard.bool(forKey: enabledKey)
    }

    enum Phase: Equatable {
        case off
        case starting(String)
        case listening
        /// The words so far, not typed in yet.
        case hearing(String)
        case failed(String)
    }

    private(set) var phase: Phase = .off
    private(set) var noteId: String?
    /// 0...1, his voice, for the bars.
    private(set) var level: Float = 0

    @ObservationIgnored private var audio: VoiceAudio?
    @ObservationIgnored private var tracker = UtteranceTracker(pause: 0.8)
    @ObservationIgnored private var endpointTimer: Timer?
    @ObservationIgnored private var startId = UUID()
    /// The note's text box (NoteEditor), and which note it's showing.
    @ObservationIgnored private weak var editor: NSTextView?
    @ObservationIgnored private var editorNoteId: String?

    var isOn: Bool {
        switch phase {
        case .off, .failed: false
        default: true
        }
    }

    func isOn(for noteId: String) -> Bool { isOn && self.noteId == noteId }

    /// NoteEditor hands over its text box each time it shows a note.
    func attach(_ view: NSTextView, noteId: String) {
        // Another note: what was waiting can't go in this one. NotesPage
        // stops first when he picks one, so this is only a backstop.
        if let shown = editorNoteId, shown != noteId, isOn { stop(typing: false) }
        editor = view
        editorNoteId = noteId
    }

    func toggle(noteId: String) {
        if isOn(for: noteId) { stop() } else { start(noteId: noteId) }
    }

    func start(noteId: String) {
        guard Self.enabled else { return }
        stop()
        // The microphone is one thing at a time.
        if VoiceMode.shared.isOn { VoiceMode.shared.stop() }
        if KeyDictation.shared.isOn { KeyDictation.shared.cancel() }
        let startId = UUID()
        self.startId = startId
        self.noteId = noteId
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
                self.phase = .listening
                self.endpointTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.checkPause() }
                }
                VoiceLog.write("dictating into a note")
            } catch {
                guard self.startId == startId else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    /// Whatever he was in the middle of saying goes in first.
    func stop(typing: Bool = true) {
        dismissFailure()
        startId = UUID()
        guard isOn || audio != nil else { return }
        if let text = tracker.flush(), typing { type(text) }
        endpointTimer?.invalidate()
        endpointTimer = nil
        audio?.stop()
        audio = nil
        tracker = UtteranceTracker(pause: 0.8)
        phase = .off
        level = 0
        noteId = nil
        VoiceLog.write("stopped dictating")
    }

    func dismissFailure() {
        if case .failed = phase { phase = .off; noteId = nil }
    }

    private func fail(_ message: String) {
        VoiceLog.write("dictation failed: \(message)")
        startId = UUID()
        endpointTimer?.invalidate()
        endpointTimer = nil
        audio?.stop()
        audio = nil
        tracker = UtteranceTracker(pause: 0.8)
        level = 0
        phase = .failed(message)
    }

    private func show(level new: Float) {
        let rounded = (new * 10).rounded() / 10
        if rounded != level { level = rounded }
    }

    private func heard(_ result: UtteranceTracker.Result) {
        guard isOn else { return }
        if tracker.add(result, now: CACurrentMediaTime()) { phase = .hearing(tracker.pending) }
    }

    private func checkPause() {
        guard let text = tracker.take(now: CACurrentMediaTime()) else { return }
        type(text)
        phase = .listening
    }

    /// Typed in at the cursor (over a selection), as if he'd typed it: it
    /// saves, colours and undoes as typing does.
    private func type(_ words: String) {
        guard let view = editor, let noteId, editorNoteId == noteId else { return }
        let string = view.string as NSString
        let range = view.selectedRange()
        let before = range.location > 0 ? Character(string.substring(with: string.rangeOfComposedCharacterSequence(at: range.location - 1))) : nil
        let end = NSMaxRange(range)
        let after = end < string.length ? Character(string.substring(with: string.rangeOfComposedCharacterSequence(at: end))) : nil
        guard let text = DictatedText.insertion(words, before: before, after: after) else { return }
        view.insertText(text, replacementRange: range)
        view.scrollRangeToVisible(view.selectedRange())
    }

    #if DEBUG
    /// The automation hook: a phase to look at, nothing listening.
    func stage(_ phase: Phase, noteId: String?, level: Float) {
        self.phase = phase
        self.noteId = noteId
        self.level = level
    }
    #endif
}
