import AppKit
import SwiftUI

/// The Voice button's icon, picked in Settings > Voice & Audio. Phosphor's icons
/// (phosphoricons.com, MIT), kept here as path data as ProviderLogo keeps
/// its marks: NSImage draws the SVG, and as a template it takes the
/// colour around it, so it reads the same in light and dark. Bold, to sit
/// beside Send's semibold arrow.
enum VoiceIcon: String, CaseIterable, Identifiable {
    case microphone
    case microphoneFill
    case microphoneStage
    case waveform

    static let key = "voiceIcon"
    static let fallback = VoiceIcon.microphone

    var id: String { rawValue }

    var title: String {
        switch self {
        case .microphone: "Microphone"
        case .microphoneFill: "Microphone, filled"
        case .microphoneStage: "Stage microphone"
        case .waveform: "Waveform"
        }
    }

    static func saved(_ raw: String) -> VoiceIcon { VoiceIcon(rawValue: raw) ?? fallback }

    @MainActor private static var cache: [String: NSImage] = [:]

    /// A square template image `side` points across.
    @MainActor
    func image(side: CGFloat) -> NSImage {
        let key = "\(rawValue)@\(side)"
        if let cached = Self.cache[key] { return cached }
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><path d=""# + path + #""/></svg>"#
        let image = NSImage(data: Data(svg.utf8)) ?? NSImage(systemSymbolName: "mic", accessibilityDescription: nil) ?? NSImage()
        image.size = NSSize(width: side, height: side)
        image.isTemplate = true
        image.accessibilityDescription = title
        Self.cache[key] = image
        return image
    }

    private var path: String {
        switch self {
        case .microphone:
            "M128,180a52.06,52.06,0,0,0,52-52V64A52,52,0,0,0,76,64v64A52.06,52.06,0,0,0,128,180ZM100,64a28,28,0,0,1,56,0v64a28,28,0,0,1-56,0Zm40,155.22V240a12,12,0,0,1-24,0V219.22A92.14,92.14,0,0,1,36,128a12,12,0,0,1,24,0,68,68,0,0,0,136,0,12,12,0,0,1,24,0A92.14,92.14,0,0,1,140,219.22Z"
        case .microphoneFill:
            "M80,128V64a48,48,0,0,1,96,0v64a48,48,0,0,1-96,0Zm128,0a8,8,0,0,0-16,0,64,64,0,0,1-128,0,8,8,0,0,0-16,0,80.11,80.11,0,0,0,72,79.6V240a8,8,0,0,0,16,0V207.6A80.11,80.11,0,0,0,208,128Z"
        case .microphoneStage:
            "M168,12A75.9,75.9,0,0,0,92.49,96.33L23.91,189.85a19.89,19.89,0,0,0,2,26l14.29,14.29a19.89,19.89,0,0,0,26,2l93.52-68.58A76,76,0,1,0,168,12Zm52,76a51.66,51.66,0,0,1-7.75,27.27L140.74,43.75A52,52,0,0,1,220,88ZM54.72,210.71l-9.43-9.43,56.19-76.63a76.46,76.46,0,0,0,29.87,29.87ZM116,88a51.63,51.63,0,0,1,7.75-27.27l71.51,71.51A52,52,0,0,1,116,88Z"
        case .waveform:
            "M60,96v64a12,12,0,0,1-24,0V96a12,12,0,0,1,24,0ZM88,20A12,12,0,0,0,76,32V224a12,12,0,0,0,24,0V32A12,12,0,0,0,88,20Zm40,32a12,12,0,0,0-12,12V192a12,12,0,0,0,24,0V64A12,12,0,0,0,128,52Zm40,32a12,12,0,0,0-12,12v64a12,12,0,0,0,24,0V96A12,12,0,0,0,168,84Zm40-16a12,12,0,0,0-12,12v96a12,12,0,0,0,24,0V80A12,12,0,0,0,208,68Z"
        }
    }
}

/// Voice's round button, off or on: off it's Send's quiet grey circle with
/// the chosen icon, so it doesn't pull the eye in light or dark; on it's
/// red with bars that follow whoever is talking.
struct VoiceCircle: View {
    let size: CGFloat
    let on: Bool
    let level: CGFloat
    let busy: Bool
    @AppStorage(VoiceIcon.key) private var icon = VoiceIcon.fallback.rawValue

    var body: some View {
        ZStack {
            if on {
                Circle().fill(Color.red)
                VoiceBars(level: level, active: true, busy: busy)
                    .frame(width: size * 0.5, height: size * 0.5)
            } else {
                Circle().fill(Color.primary.opacity(0.1))
                Image(nsImage: VoiceIcon.saved(icon).image(side: (size * 0.54).rounded()))
                    .renderingMode(.template)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .contentShape(Circle())
    }
}
