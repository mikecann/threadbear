import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct PlansTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func m(_ seq: Int, _ role: PhoneMessage.Role, _ text: String, at: Double, plan: Bool = false) -> PhoneMessage {
        PhoneMessage(seq: seq, role: role, text: text, toolKind: role == .tool ? "command" : nil, plan: plan, at: t0.addingTimeInterval(at))
    }

    @Test func titleIsTheFirstHeadingWithoutItsMarks() {
        #expect(Plans.title(of: "# Bots and **webhook** triggers\n\nSteps") == "Bots and webhook triggers")
        #expect(Plans.title(of: "Just do `x`\nthen y") == "Just do x")
        #expect(Plans.title(of: "  \n") == "Plan")
        #expect(Plans.body(of: "\n# Title\n\n## Context\nWhy") == "## Context\nWhy")
        #expect(Plans.body(of: "No heading\nmore") == "No heading\nmore")
    }

    @Test func fileNameIsTheTitleInWords() {
        #expect(Plans.fileName(for: "# Bots & webhook triggers for Threadbear") == "bots-webhook-triggers-for-threadbear.md")
        #expect(Plans.fileName(for: "# !!!") == "plan.md")
    }

    @Test func onlyAnExitPlanModeCardWaitsForGoAhead() {
        #expect(Plans.waiting(.approval(id: "a", name: "ExitPlanMode", title: "Finish the plan", options: [.allow, .deny], inputSummary: nil)))
        #expect(!Plans.waiting(.approval(id: "a", name: "Bash", title: "Run", options: [.allow], inputSummary: "ls")))
        #expect(!Plans.waiting(nil))
        // Go ahead only where the runner offers Allow on it.
        #expect(Plans.canGoAhead(.approval(id: "a", name: "ExitPlanMode", title: "Finish the plan", options: [.allow, .deny], inputSummary: nil)))
        #expect(!Plans.canGoAhead(.approval(id: "a", name: "ExitPlanMode", title: "Finish the plan", options: [.deny], inputSummary: nil)))
        #expect(!Plans.canGoAhead(.approval(id: "a", name: "Bash", title: "Run", options: [.allow], inputSummary: "ls")))
    }

    @Test func rowsCarryThePlanMark() throws {
        let row = ##"{"seq": 4.0, "role": "assistant", "text": "# P", "plan": true, "at": "2026-11-10T00:00:00.000Z"}"##
        let message = try JSONDecoder().decode(PhoneMessage.self, from: Data(row.utf8))
        #expect(message.plan)
        let again = try JSONDecoder().decode(PhoneMessage.self, from: JSONEncoder().encode(message))
        #expect(again.plan)
        let old = #"{"seq": 4.0, "role": "assistant", "text": "x", "at": "2026-11-10T00:00:00.000Z"}"#
        #expect(try !JSONDecoder().decode(PhoneMessage.self, from: Data(old.utf8)).plan)
    }

    /// A plan sent back, then the agent's reply: the plan stays in view,
    /// not folded into the turn's working with the steps around it.
    @Test func aFinishedTurnKeepsItsPlanInView() {
        let messages = [
            m(1, .user, "Plan the bots", at: 0),
            m(2, .tool, "Read the schema", at: 5),
            m(3, .assistant, "# Bots\n\n1. Add a table", at: 10, plan: true),
            m(4, .tool, "Finish the plan", at: 11),
            m(5, .assistant, "Waiting on your go.", at: 12),
        ]
        let items = Turns.fold(messages, busy: false)
        let shown = items.compactMap { item -> Int? in if case let .message(message) = item { return message.seq } else { return nil } }
        #expect(shown == [1, 3, 5])
        #expect(Plans.latest(in: messages)?.seq == 3)
    }
}
