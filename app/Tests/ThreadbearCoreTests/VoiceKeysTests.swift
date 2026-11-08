import XCTest
@testable import ThreadbearCore

final class VoiceKeysTests: XCTestCase {
    private func machine(_ edit: (inout VoiceKeys) -> Void = { _ in }) -> VoiceKeyMachine {
        var keys = VoiceKeys()
        edit(&keys)
        return VoiceKeyMachine(keys: keys)
    }

    func testHoldDictatesAndReleaseTypesItIn() {
        var m = machine()
        XCTAssertEqual(m.handle(.triggerDown(at: 0)).actions, [.waitToHold(pressedAt: 0)])
        XCTAssertEqual(m.handle(.holdDelayPassed(pressedAt: 0)).actions, [.start(.dictating)])
        XCTAssertEqual(m.mode, .dictating)
        XCTAssertEqual(m.handle(.triggerUp(at: 2)).actions, [.finish])
        XCTAssertEqual(m.mode, .idle)
    }

    func testATapNeverListens() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        XCTAssertEqual(m.handle(.triggerUp(at: 0.1)).actions, [])
        // The hold delay running out after the tap does nothing.
        XCTAssertEqual(m.handle(.holdDelayPassed(pressedAt: 0)).actions, [])
        XCTAssertEqual(m.mode, .idle)
    }

    func testDoubleTapStartsHandsFreeAndATapStopsIt() {
        var m = machine { $0.doubleTap = true }
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.triggerUp(at: 0.1))
        XCTAssertEqual(m.handle(.triggerDown(at: 0.3)).actions, [.start(.handsFree)])
        XCTAssertEqual(m.handle(.triggerUp(at: 0.4)).actions, [])
        XCTAssertEqual(m.mode, .handsFree)
        // Typing while it listens is left alone.
        XCTAssertEqual(m.handle(.keyDown(.other)), .init())
        _ = m.handle(.triggerDown(at: 5))
        XCTAssertEqual(m.handle(.triggerUp(at: 5.1)).actions, [.finish])
        XCTAssertEqual(m.mode, .idle)
    }

    func testTapsTooFarApartAreNotADoubleTap() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.triggerUp(at: 0.1))
        XCTAssertEqual(m.handle(.triggerDown(at: 1)).actions, [.waitToHold(pressedAt: 1)])
    }

    func testDoubleTapIsOffByDefault() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.triggerUp(at: 0.1))
        XCTAssertEqual(m.handle(.triggerDown(at: 0.3)).actions, [.waitToHold(pressedAt: 0.3)])
    }

    func testTriggerSpaceTogglesHandsFreeAndSwallowsTheSpace() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        XCTAssertEqual(m.handle(.keyDown(.space)), .init([.start(.handsFree)], swallow: true))
        XCTAssertEqual(m.handle(.triggerUp(at: 0.5)).actions, [])
        XCTAssertEqual(m.mode, .handsFree)
        _ = m.handle(.triggerDown(at: 3))
        XCTAssertEqual(m.handle(.keyDown(.space)), .init([.finish], swallow: true))
        XCTAssertEqual(m.handle(.triggerUp(at: 3.2)).actions, [])
        XCTAssertEqual(m.mode, .idle)
    }

    func testShiftTriggerTogglesHandsFree() {
        var m = machine()
        // Shift held first, then Fn: the monitor sends both.
        _ = m.handle(.triggerDown(at: 0))
        XCTAssertEqual(m.handle(.shiftDown), .init([.start(.handsFree)]))
        XCTAssertEqual(m.handle(.triggerUp(at: 0.3)).actions, [])
        XCTAssertEqual(m.mode, .handsFree)
        // Shift + Fn again stops it, typing in the rest.
        _ = m.handle(.triggerDown(at: 4))
        XCTAssertEqual(m.handle(.shiftDown).actions, [.finish])
        XCTAssertEqual(m.handle(.triggerUp(at: 4.2)).actions, [])
        XCTAssertEqual(m.mode, .idle)
    }

    func testShiftCanBeTurnedOff() {
        var m = machine { $0.shiftToggle = false }
        _ = m.handle(.triggerDown(at: 0))
        XCTAssertEqual(m.handle(.shiftDown).actions, [])
        XCTAssertEqual(m.handle(.holdDelayPassed(pressedAt: 0)).actions, [])
    }

    func testSpaceDuringAHoldCarriesOnHandsFree() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.holdDelayPassed(pressedAt: 0))
        XCTAssertEqual(m.handle(.keyDown(.space)).actions, [.start(.handsFree)])
        XCTAssertEqual(m.handle(.triggerUp(at: 1)).actions, [])
        XCTAssertEqual(m.mode, .handsFree)
    }

    func testSpaceWithoutTheTriggerIsJustASpace() {
        var m = machine()
        XCTAssertEqual(m.handle(.keyDown(.space)), .init())
    }

    func testFnAsAModifierNeverListens() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        XCTAssertEqual(m.handle(.keyDown(.other)), .init())
        XCTAssertEqual(m.handle(.holdDelayPassed(pressedAt: 0)).actions, [])
        XCTAssertEqual(m.handle(.triggerUp(at: 1)).actions, [])
        // And it isn't a tap towards a double tap.
        _ = m.handle(.triggerDown(at: 1.1))
        XCTAssertEqual(m.mode, .idle)
    }

    func testAKeyDuringAHoldCancelsIt() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.holdDelayPassed(pressedAt: 0))
        XCTAssertEqual(m.handle(.keyDown(.other)).actions, [.cancel])
        XCTAssertEqual(m.handle(.triggerUp(at: 1)).actions, [])
    }

    func testEscCancelsAndIsSwallowedOnlyWhileListening() {
        var m = machine()
        XCTAssertEqual(m.handle(.keyDown(.escape)), .init())
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.holdDelayPassed(pressedAt: 0))
        XCTAssertEqual(m.handle(.keyDown(.escape)), .init([.cancel], swallow: true))
        XCTAssertEqual(m.handle(.triggerUp(at: 1)).actions, [])

        _ = m.handle(.triggerDown(at: 5))
        _ = m.handle(.keyDown(.space))
        _ = m.handle(.triggerUp(at: 5.2))
        XCTAssertEqual(m.handle(.keyDown(.escape)), .init([.cancel], swallow: true))
        XCTAssertEqual(m.mode, .idle)
    }

    func testCommandModeOnlyWhenTurnedOn() {
        var off = machine()
        _ = off.handle(.triggerDown(at: 0))
        XCTAssertEqual(off.handle(.commandKeyDown).actions, [])
        XCTAssertEqual(off.handle(.holdDelayPassed(pressedAt: 0)).actions, [])

        var on = machine { $0.commandMode = true }
        _ = on.handle(.triggerDown(at: 0))
        XCTAssertEqual(on.handle(.commandKeyDown).actions, [.start(.command)])
        XCTAssertEqual(on.handle(.holdDelayPassed(pressedAt: 0)).actions, [])
        XCTAssertEqual(on.handle(.triggerUp(at: 2)).actions, [.finish])
    }

    func testCommandKeyDuringAHoldSwitchesIt() {
        var m = machine { $0.commandMode = true }
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.holdDelayPassed(pressedAt: 0))
        XCTAssertEqual(m.handle(.commandKeyDown).actions, [.start(.command)])
        XCTAssertEqual(m.mode, .command)
    }

    func testHoldCanBeTurnedOff() {
        var m = machine { $0.holdToDictate = false }
        XCTAssertEqual(m.handle(.triggerDown(at: 0)).actions, [])
        XCTAssertEqual(m.handle(.holdDelayPassed(pressedAt: 0)).actions, [])
        // Fn-Space still works.
        XCTAssertEqual(m.handle(.keyDown(.space)).actions, [.start(.handsFree)])
    }

    func testEndedElsewhereLeavesTheHeldKeyDoingNothing() {
        var m = machine()
        _ = m.handle(.triggerDown(at: 0))
        _ = m.handle(.holdDelayPassed(pressedAt: 0))
        m.ended()
        XCTAssertEqual(m.mode, .idle)
        XCTAssertEqual(m.handle(.triggerUp(at: 1)).actions, [])
    }

    func testSettingsReadFromDefaults() {
        let defaults = UserDefaults(suiteName: "VoiceKeysTests-\(UUID())")!
        XCTAssertEqual(VoiceKeys(defaults: defaults), VoiceKeys())
        defaults.set("rightOption", forKey: VoiceKeys.triggerKey)
        defaults.set(false, forKey: VoiceKeys.shiftKey)
        defaults.set(true, forKey: VoiceKeys.commandModeKey)
        defaults.set("shift", forKey: VoiceKeys.commandKey)
        let keys = VoiceKeys(defaults: defaults)
        XCTAssertEqual(keys.trigger, .rightOption)
        XCTAssertFalse(keys.shiftToggle)
        XCTAssertFalse(keys.doubleTap)
        XCTAssertEqual(VoiceKeys().shiftDisplay, "⇧ Fn")
        XCTAssertTrue(keys.holdToDictate)
        XCTAssertTrue(keys.commandMode)
        XCTAssertEqual(keys.commandDisplay, "Right ⌥ ⇧")
        XCTAssertEqual(VoiceKeys().holdDisplay, "Hold Fn")
        XCTAssertEqual(VoiceKeys().handsFreeDisplay, "Fn Space")
    }
}
