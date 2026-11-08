import Foundation

/// The key Voice's keyboard shortcuts are built on (Settings > Keyboard >
/// Voice). Fn by default, as other dictation apps have it; the right-hand
/// Option or Command for a keyboard without one, or a Mac where macOS
/// keeps Fn for itself. Raw values are what UserDefaults holds.
public enum VoiceTriggerKey: String, CaseIterable, Sendable {
    case fn
    case rightOption
    case rightCommand

    /// How a key cap writes it: "Fn", "Right ⌥".
    public var display: String {
        switch self {
        case .fn: "Fn"
        case .rightOption: "Right ⌥"
        case .rightCommand: "Right ⌘"
        }
    }

    /// For the picker.
    public var title: String {
        switch self {
        case .fn: "Fn (Globe)"
        case .rightOption: "Right Option"
        case .rightCommand: "Right Command"
        }
    }

    /// The key's virtual key code, as a flagsChanged event has it.
    public var keyCode: UInt16 {
        switch self {
        case .fn: 63
        case .rightOption: 61
        case .rightCommand: 54
        }
    }
}

/// The key held with the trigger for Command Mode.
public enum VoiceCommandKey: String, CaseIterable, Sendable {
    case control
    case option
    case shift

    public var display: String {
        switch self {
        case .control: "⌃"
        case .option: "⌥"
        case .shift: "⇧"
        }
    }

    public var title: String {
        switch self {
        case .control: "Control"
        case .option: "Option"
        case .shift: "Shift"
        }
    }

    /// Both sides' key codes: either one counts.
    public var keyCodes: Set<UInt16> {
        switch self {
        case .control: [59, 62]
        case .option: [58, 61]
        case .shift: [56, 60]
        }
    }
}

/// Voice's keyboard shortcuts, as Settings has them. They only work while
/// Voice is on (Settings > Voice & Audio > Use Voice).
public struct VoiceKeys: Equatable, Sendable {
    public var trigger: VoiceTriggerKey = .fn
    /// Hold the trigger to dictate; let go to type it in.
    public var holdToDictate = true
    /// Trigger + Space starts and stops hands-free dictation.
    public var handsFreeWithSpace = true
    /// Shift + trigger starts and stops hands-free dictation too.
    public var shiftToggle = true
    /// Two quick taps of the trigger start hands-free dictation. Off by
    /// default: a double tap of Fn is macOS's emoji or dictation too.
    public var doubleTap = false
    /// Settings > Voice & Audio > Command Mode: off until turned on.
    public var commandMode = false
    public var command: VoiceCommandKey = .control

    public init() {}

    public static let triggerKey = "voiceKeyTrigger"
    public static let holdKey = "voiceKeyHold"
    public static let handsFreeKey = "voiceKeyHandsFree"
    public static let shiftKey = "voiceKeyShift"
    public static let doubleTapKey = "voiceKeyDoubleTap"
    public static let commandModeKey = "voiceCommandMode"
    public static let commandKey = "voiceKeyCommand"

    public init(defaults: UserDefaults) {
        trigger = defaults.string(forKey: Self.triggerKey).flatMap(VoiceTriggerKey.init(rawValue:)) ?? .fn
        holdToDictate = defaults.object(forKey: Self.holdKey) as? Bool ?? true
        handsFreeWithSpace = defaults.object(forKey: Self.handsFreeKey) as? Bool ?? true
        shiftToggle = defaults.object(forKey: Self.shiftKey) as? Bool ?? true
        doubleTap = defaults.object(forKey: Self.doubleTapKey) as? Bool ?? false
        commandMode = defaults.bool(forKey: Self.commandModeKey)
        command = defaults.string(forKey: Self.commandKey).flatMap(VoiceCommandKey.init(rawValue:)) ?? .control
    }

    /// Settings > Keyboard's caps: "Hold Fn", "Fn Space".
    public var holdDisplay: String { "Hold \(trigger.display)" }
    public var handsFreeDisplay: String { "\(trigger.display) Space" }
    public var shiftDisplay: String { "⇧ \(trigger.display)" }
    public var doubleTapDisplay: String { "\(trigger.display) \(trigger.display)" }
    public var commandDisplay: String { "\(trigger.display) \(command.display)" }
}

/// Turns presses of the trigger key into what Voice's shortcuts do, with
/// time passed in so it can be tested. The app feeds it key events and
/// does the actions (KeyDictation).
///
/// - Hold the trigger: after `holdDelay` it starts listening, and letting
///   go types in what was said. A shorter press is a tap, and so is the
///   trigger used as a modifier (Fn-Delete, Fn-arrow): neither listens.
/// - Trigger + Space, or Shift + trigger, starts hands-free dictation, and
///   again stops it. Two taps within `doubleTapGap` start it too, if
///   that's on; a tap of the trigger while it's on stops it.
/// - Trigger + the Command Mode key, held: what's said goes to the thread
///   as a message when you let go.
/// - Esc while any of them is on cancels it, with nothing typed or sent.
public struct VoiceKeyMachine: Sendable {
    public enum Mode: Equatable, Sendable {
        case idle
        /// Held: typed in on release.
        case dictating
        /// Typed in at each pause until stopped.
        case handsFree
        /// Held: sent to the thread on release.
        case command
    }

    public enum Key: Equatable, Sendable {
        case space, escape, other
    }

    public enum Event: Equatable, Sendable {
        case triggerDown(at: Double)
        case triggerUp(at: Double)
        /// The hold delay for the press that started at this time ran out.
        case holdDelayPassed(pressedAt: Double)
        /// The Command Mode key went down.
        case commandKeyDown
        /// Shift went down with the trigger (either first).
        case shiftDown
        /// Another modifier went down.
        case otherModifierDown
        case keyDown(Key)
    }

    public enum Action: Equatable, Sendable {
        /// Wait `holdDelay`, then send holdDelayPassed for this press.
        case waitToHold(pressedAt: Double)
        /// Start listening for this, or switch what's listening to it.
        case start(Mode)
        /// Done: type in, or send, what was heard.
        case finish
        /// Stop with nothing typed in or sent.
        case cancel
    }

    public struct Outcome: Equatable, Sendable {
        public var actions: [Action]
        /// The key goes no further: Fn-Space doesn't type a space.
        public var swallow: Bool

        public init(_ actions: [Action] = [], swallow: Bool = false) {
            self.actions = actions
            self.swallow = swallow
        }
    }

    public static let holdDelay = 0.25
    public static let doubleTapGap = 0.4

    public var keys: VoiceKeys
    public private(set) var mode: Mode = .idle
    private var press: Press = .up
    private var lastTap: Double?

    private enum Press: Equatable {
        case up
        /// Down, not doing anything yet: a tap or a hold to come.
        case down(Double)
        /// Holding to dictate or to command.
        case acting
        /// Pressed while hands-free is on: a tap stops it.
        case stopping
        /// Used for something else (a modifier, Fn-Space): nothing on release.
        case spent
    }

    public init(keys: VoiceKeys = VoiceKeys()) {
        self.keys = keys
    }

    /// Whether the trigger is held now.
    public var triggerHeld: Bool { press != .up }

    /// Listening ended some other way (it failed, or Voice took the
    /// microphone): back to idle, and a key still held does nothing more.
    public mutating func ended() {
        mode = .idle
        if press != .up { press = .spent }
    }

    public mutating func handle(_ event: Event) -> Outcome {
        switch event {
        case .triggerDown(let at):
            if mode == .handsFree {
                press = .stopping
                return Outcome()
            }
            guard mode == .idle else { return Outcome() }
            if keys.doubleTap, let lastTap, at - lastTap <= Self.doubleTapGap {
                self.lastTap = nil
                press = .spent
                mode = .handsFree
                return Outcome([.start(.handsFree)])
            }
            press = .down(at)
            return keys.holdToDictate ? Outcome([.waitToHold(pressedAt: at)]) : Outcome()

        case .holdDelayPassed(let pressedAt):
            guard press == .down(pressedAt), mode == .idle, keys.holdToDictate else { return Outcome() }
            press = .acting
            mode = .dictating
            return Outcome([.start(.dictating)])

        case .commandKeyDown:
            guard keys.commandMode else { return otherModifier() }
            switch press {
            case .down:
                break
            case .acting where mode == .dictating:
                break
            default:
                return Outcome()
            }
            press = .acting
            mode = .command
            return Outcome([.start(.command)])

        case .otherModifierDown:
            return otherModifier()

        case .shiftDown:
            guard keys.shiftToggle else { return otherModifier() }
            return toggleHandsFree(swallow: false) ?? Outcome()

        case .keyDown(.space):
            guard keys.handsFreeWithSpace else { return otherKey() }
            return toggleHandsFree(swallow: true) ?? otherKey()

        case .keyDown(.escape):
            guard mode != .idle else { return Outcome() }
            mode = .idle
            if press != .up { press = .spent }
            return Outcome([.cancel], swallow: true)

        case .keyDown(.other):
            return otherKey()

        case .triggerUp(let at):
            defer { press = .up }
            switch press {
            case .down:
                // Let go before the hold delay: a tap.
                lastTap = at
                return Outcome()
            case .acting, .stopping:
                lastTap = nil
                mode = .idle
                return Outcome([.finish])
            case .up, .spent:
                lastTap = nil
                return Outcome()
            }
        }
    }

    /// Trigger + Space or Shift: hands-free on, or off if it's on. Nil if
    /// the trigger isn't held for it.
    private mutating func toggleHandsFree(swallow: Bool) -> Outcome? {
        switch press {
        case .stopping:
            press = .spent
            mode = .idle
            return Outcome([.finish], swallow: swallow)
        case .down, .acting:
            press = .spent
            mode = .handsFree
            return Outcome([.start(.handsFree)], swallow: swallow)
        case .up, .spent:
            return nil
        }
    }

    private mutating func otherModifier() -> Outcome {
        if case .down = press { press = .spent }
        return Outcome()
    }

    /// A key typed with the trigger held is the trigger used as a modifier
    /// (Fn-Delete, Fn-arrow): it never starts listening, and it ends a
    /// hold under way. Typing during hands-free is left alone.
    private mutating func otherKey() -> Outcome {
        switch press {
        case .down, .stopping:
            press = .spent
            lastTap = nil
            return Outcome()
        case .acting:
            press = .spent
            mode = .idle
            return Outcome([.cancel])
        case .up, .spent:
            return Outcome()
        }
    }
}
