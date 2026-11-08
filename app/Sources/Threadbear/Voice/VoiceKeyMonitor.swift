import AppKit
import ThreadbearCore

/// Watches the keyboard for Voice's shortcuts (Settings > Keyboard >
/// Voice) and hands what they mean to KeyDictation. VoiceKeyMachine
/// works out holds, taps and chords; this only turns NSEvents into its
/// events. Inside Threadbear only (a local monitor), so it needs no
/// Accessibility or Input Monitoring permission, and it does nothing at
/// all unless Voice is on.
@MainActor
final class VoiceKeyMonitor {
    static let shared = VoiceKeyMonitor()

    private var monitor: Any?
    private var resignObserver: NSObjectProtocol?
    private var machine = VoiceKeyMachine()
    private var triggerDown = false
    /// Fn-Space's space was swallowed: its key repeats are too.
    private var swallowingSpace = false

    func install() {
        guard monitor == nil else { return }
        KeyDictation.shared.onEnded = { [weak self] in self?.machine.ended() }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { event in
            let swallowed = MainActor.assumeIsolated { VoiceKeyMonitor.shared.swallows(event) }
            return swallowed ? nil : event
        }
        // Switching away with the key held: it never sees the key come up.
        resignObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { VoiceKeyMonitor.shared.letGo() }
        }
    }

    private var active: Bool {
        VoiceMode.enabled && ShortcutRecorder.shared.command == nil
    }

    func swallows(_ event: NSEvent) -> Bool {
        guard active else {
            if triggerDown || machine.mode != .idle { letGo() }
            return false
        }
        switch event.type {
        case .flagsChanged:
            let keys = VoiceKeys(defaults: .standard)
            machine.keys = keys
            let code = event.keyCode
            if code == keys.trigger.keyCode {
                let down = Self.isDown(keys.trigger, event.modifierFlags)
                guard down != triggerDown else { return false }
                triggerDown = down
                if !down { swallowingSpace = false }
                run(down ? .triggerDown(at: event.timestamp) : .triggerUp(at: event.timestamp))
            } else if triggerDown, Self.modifierWentDown(code, event.modifierFlags) {
                run(keys.command.keyCodes.contains(code) ? .commandKeyDown : .otherModifierDown)
            }
            return false
        case .keyDown:
            guard triggerDown || machine.mode != .idle else { return false }
            if event.isARepeat, event.keyCode == 49, swallowingSpace { return true }
            let key: VoiceKeyMachine.Key = switch event.keyCode {
            case 49: .space
            case 53: .escape
            default: .other
            }
            let swallowed = run(.keyDown(key))
            if key == .space, swallowed { swallowingSpace = true }
            return swallowed
        default:
            return false
        }
    }

    /// The key's up, whatever the events said: what was held finishes.
    private func letGo() {
        swallowingSpace = false
        guard triggerDown else { return }
        triggerDown = false
        run(.triggerUp(at: ProcessInfo.processInfo.systemUptime))
    }

    @discardableResult
    private func run(_ event: VoiceKeyMachine.Event) -> Bool {
        let outcome = machine.handle(event)
        for action in outcome.actions {
            switch action {
            case .waitToHold(let pressedAt):
                DispatchQueue.main.asyncAfter(deadline: .now() + VoiceKeyMachine.holdDelay) { [weak self] in
                    MainActor.assumeIsolated { _ = self?.run(.holdDelayPassed(pressedAt: pressedAt)) }
                }
            case .start(let mode):
                KeyDictation.shared.start(mode)
            case .finish:
                KeyDictation.shared.finish()
            case .cancel:
                KeyDictation.shared.cancel()
            }
        }
        return outcome.swallow
    }

    /// Whether the trigger is held, by its own side's bit for the right-hand
    /// keys, so the left one held as well doesn't keep it down.
    private static func isDown(_ trigger: VoiceTriggerKey, _ flags: NSEvent.ModifierFlags) -> Bool {
        switch trigger {
        case .fn: flags.contains(.function)
        case .rightOption: flags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0
        case .rightCommand: flags.rawValue & UInt(NX_DEVICERCMDKEYMASK) != 0
        }
    }

    /// A modifier key's flagsChanged that pressed it rather than let it go.
    private static func modifierWentDown(_ code: UInt16, _ flags: NSEvent.ModifierFlags) -> Bool {
        switch code {
        case 59, 62: flags.contains(.control)
        case 58, 61: flags.contains(.option)
        case 56, 60: flags.contains(.shift)
        case 55, 54: flags.contains(.command)
        case 63: flags.contains(.function)
        default: false
        }
    }
}
