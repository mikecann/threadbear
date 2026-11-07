import SwiftUI
import ThreadbearCore

/// The note's microphone (Settings > Voice & Audio > Use with Notes): Voice's
/// waveform in a circle, blue to start and red while it listens, its bars
/// following his voice. NoteDictation does the listening.
struct NoteDictationButton: View {
    let noteId: String
    let size: CGFloat
    @State private var dictation = NoteDictation.shared

    var body: some View {
        let on = dictation.isOn(for: noteId)
        Button {
            dictation.toggle(noteId: noteId)
        } label: {
            VoiceBars(level: on ? CGFloat(dictation.level) : 0, active: on, busy: starting)
                .frame(width: size * 0.5, height: size * 0.5)
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(Circle().fill(on ? Color.red : Color.accentColor))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .tip(on ? "Stop talking into this note (Esc)" : "Talk into this note: what you say is typed in at the cursor, on this Mac")
        .accessibilityLabel(on ? "Stop dictating" : "Dictate into this note")
        .animation(.easeOut(duration: 0.15), value: on)
    }

    private var starting: Bool {
        if case .starting = dictation.phase { return true }
        return false
    }
}

/// Under the note while he talks into it: what it's doing, or the words
/// it's heard that aren't typed in yet, or why it couldn't start.
struct NoteDictationStrip: View {
    @State private var dictation = NoteDictation.shared

    var body: some View {
        HStack(spacing: zoomed(8)) {
            Image(systemName: failed ? "exclamationmark.triangle.fill" : "mic.fill")
                .font(.system(size: zoomed(11)))
                .foregroundStyle(failed ? Color.orange : Color.red)
            Text(line)
                .font(.callout)
                .foregroundStyle(heard ? .primary : .secondary)
                .lineLimit(2)
                // The newest words matter most while he talks.
                .truncationMode(heard ? .head : .tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if failed {
                Button("OK") { dictation.dismissFailure() }
                    .tip("Close this message")
            } else {
                Button("Done") { dictation.stop() }
                    .tip("Stop talking into this note (Esc)")
            }
        }
        .padding(.horizontal, zoomed(16))
        .padding(.vertical, zoomed(8))
        .background(Color.primary.opacity(0.03))
    }

    private var failed: Bool {
        if case .failed = dictation.phase { return true }
        return false
    }

    private var heard: Bool {
        if case .hearing = dictation.phase { return true }
        return false
    }

    private var line: String {
        switch dictation.phase {
        case .off: ""
        case .starting(let status): status
        case .listening: "Listening. Say “new line” for a line break."
        case .hearing(let words): words
        case .failed(let message): message
        }
    }
}
