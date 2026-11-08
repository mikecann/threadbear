import XCTest
@testable import ThreadbearCore

final class OutsideAgentAppsTests: XCTestCase {
    func testThePanelOffersGrokBotNotionAndSlack() {
        XCTAssertEqual(OutsideAgentApp.all.map(\.name), ["Grok Bot", "Notion", "Slack"])
        XCTAssertEqual(Set(OutsideAgentApp.all.map(\.id)).count, OutsideAgentApp.all.count)
        for app in OutsideAgentApp.all {
            XCTAssertEqual(app.docs.scheme, "https", app.name)
            for text in [app.needs, app.intro, app.outro] { XCTAssertFalse(text.contains("—"), "no em dashes in UI copy") }
        }
    }

    func testSlackCantTakeAKeySoItHasNoMakeKey() {
        XCTAssertFalse(OutsideAgentApp.slack.canConnect)
        XCTAssertTrue(OutsideAgentApp.slack.needs.contains("OAuth"))
        XCTAssertTrue(OutsideAgentApp.notion.canConnect)
        XCTAssertTrue(OutsideAgentApp.grokBot.canConnect)
    }

    func testGrokBotKeepsItsOwnFormAndNotionGetsTheKeyAsAHeader() {
        let grok = OutsideAgentApp.grokBot.form(url: "https://x.convex.site/mcp", secret: "tba_0123456789abcdef")
        XCTAssertEqual(grok, ConnectorsText.agentForm(url: "https://x.convex.site/mcp", secret: "tba_0123456789abcdef"))
        let notion = OutsideAgentApp.notion.form(url: "https://x.convex.site/mcp", secret: "tba_0123456789abcdef")
        XCTAssertEqual(notion.map(\.label), ["Name", "Server URL", "Auth", "Header key", "Header value"])
        XCTAssertEqual(notion.last?.value, "Bearer tba_0123456789abcdef")
        XCTAssertFalse(notion.contains { $0.shown.contains("tba_0123456789abcdef") }, "the key is copied, never shown")
    }

    func testAKeyNamedByHandGetsWordingForAnyAgent() {
        let other = OutsideAgentApp.forKey(named: "My agent")
        XCTAssertTrue(other.intro.hasPrefix("In My agent,"))
        XCTAssertEqual(OutsideAgentApp.forKey(named: "Notion"), .notion)
        XCTAssertEqual(OutsideAgentApp.forKey(named: "Grok Bot"), .grokBot)
    }
}
