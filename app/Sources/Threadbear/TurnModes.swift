import AppKit
import ThreadbearCore

/// Plan and Ask modes (docs/protocol.md, "Plan and Ask modes"): Shift-Tab
/// in the composer steps off, Plan, Ask, off. Plan sends a read-only turn
/// whose reply is saved as plans/<date>-<project>.md; Ask a read-only one
/// that just answers. Off shows nothing, as before. Settings > General
/// can turn the modes off altogether.
enum TurnModes {
    static let enabledKey = "turnModesEnabled"
    static var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
}

extension TurnMode {
    var title: String {
        switch self {
        case .plan: "Plan"
        case .ask: "Ask"
        }
    }

    var symbol: String {
        switch self {
        case .plan: "list.bullet.clipboard"
        case .ask: "questionmark.bubble"
        }
    }

    var help: String {
        switch self {
        case .plan: "Plan mode: nothing changes; the reply is a plan, saved in plans/. Shift-Tab for Ask mode"
        case .ask: "Ask mode: nothing changes; it just answers. Shift-Tab to turn it off"
        }
    }
}

extension AppModel {
    /// The composer's mode, while the modes are on.
    func turnMode(for key: String) -> TurnMode? {
        TurnModes.enabled ? turnModes[key] : nil
    }

    /// Shift-Tab: the next mode for that composer. False when the modes are
    /// off, so Shift-Tab does what it always did.
    @discardableResult
    func cycleTurnMode(_ key: String) -> Bool {
        guard TurnModes.enabled else { return false }
        turnModes[key] = TurnMode.next(after: turnModes[key])
        return true
    }
}
