import AppKit
import ThreadbearCore

/// Shift-Tab in the composer steps off, Plan first, Ask, off (docs/protocol.md,
/// "Ask mode"). Plan first is the thread's own permission mode (Mike's: the
/// agent plans and waits for Go ahead on its plan card, and the plan is also
/// saved as plans/<date>-<project>.md); stepping on from it puts back the mode
/// it had. Ask sends each message read-only, just to be answered, with its
/// chip beside the permission one. Off is as before. Settings > General can
/// turn Shift-Tab's modes off altogether.
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
        case .plan: "Plan mode"
        case .ask: "Ask mode: nothing changes; it just answers. Shift-Tab to turn it off"
        }
    }
}

extension AppModel {
    /// The composer's Ask mode, while the modes are on.
    func turnMode(for key: String) -> TurnMode? {
        TurnModes.enabled && turnModes[key] == .ask ? .ask : nil
    }

    /// Shift-Tab: off, Plan first, Ask, off for that composer (a thread's id,
    /// or "new"). False when the modes are off, so Shift-Tab does what it did.
    @discardableResult
    func cycleTurnMode(_ key: String) -> Bool {
        guard TurnModes.enabled else { return false }
        let mode = permission(for: key)
        if mode == .plan {
            // Plan first to Ask: back to the access it had before.
            setPermission(for: key, planPutBack.removeValue(forKey: key) ?? .full)
            turnModes[key] = .ask
        } else if turnModes[key] == .ask {
            turnModes[key] = nil
        } else {
            planPutBack[key] = mode
            setPermission(for: key, .plan)
        }
        return true
    }

    private func permission(for key: String) -> PermissionMode {
        key == "new" ? newThreadPermission : threads[key]?.permissionMode ?? .full
    }

    private func setPermission(for key: String, _ mode: PermissionMode) {
        if key == "new" { newThreadPermission = mode } else { setPermission(key, mode) }
    }
}
