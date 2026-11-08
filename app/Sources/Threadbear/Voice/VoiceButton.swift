import SwiftUI
import ThreadbearCore

/// Voice mode's button beside Send: the icon picked in Settings > Voice & Audio in
/// Send's grey circle, and red while it's on, its bars moving with whoever
/// is talking (VoiceCircle).
struct VoiceButton: View {
    /// Nil for a chat not started yet (the bear's): `startNew` starts it,
    /// and Voice with it.
    let threadId: String?
    let size: CGFloat
    var startNew: (() -> Void)? = nil
    @State private var voice = VoiceMode.shared

    var body: some View {
        let on = threadId.map { voice.isOn(for: $0) } ?? false
        HStack(spacing: 6) {
            Button {
                if let threadId { voice.toggle(threadId: threadId) } else { startNew?() }
            } label: {
                VoiceCircle(size: size, on: on, level: on ? CGFloat(voice.level) : 0, busy: busy)
            }
            .buttonStyle(.plain)
            .tip(on ? "End voice" : "Talk with this thread out loud")
            .accessibilityLabel(on ? "End voice" : "Start voice")
        }
        .animation(.easeOut(duration: 0.15), value: on)
        .popover(isPresented: failureShown) {
            if case .failed(let message) = voice.phase {
                Text(message)
                    .padding(12)
                    .frame(maxWidth: 300)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(get: {
            if case .failed = voice.phase, threadId != nil, voice.threadId == threadId { return true }
            return false
        }, set: { if !$0 { voice.dismissFailure() } })
    }

    private var busy: Bool {
        switch voice.phase {
        case .starting, .thinking: true
        default: false
        }
    }

}

/// Five bars: still when off, gently pulsing while busy, and following the
/// sound level while someone talks.
struct VoiceBars: View {
    let level: CGFloat
    let active: Bool
    let busy: Bool
    private let shape: [CGFloat] = [0.45, 0.75, 1, 0.75, 0.45]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !active)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            GeometryReader { geo in
                HStack(alignment: .center, spacing: geo.size.width * 0.1) {
                    ForEach(0..<5, id: \.self) { i in
                        Capsule()
                            .frame(width: geo.size.width * 0.12, height: geo.size.height * height(i, t))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
            }
        }
    }

    private func height(_ i: Int, _ t: Double) -> CGFloat {
        guard active else { return shape[i] * 0.8 }
        if busy, level < 0.05 { return 0.3 + 0.25 * CGFloat((sin(t * 4 + Double(i) * 0.8) + 1) / 2) }
        let wobble = CGFloat((sin(t * 11 + Double(i) * 1.7) + 1) / 2)
        return max(0.2, min(1, shape[i] * (0.25 + level * (0.6 + 0.4 * wobble))))
    }
}
