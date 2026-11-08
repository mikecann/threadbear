import XCTest
@testable import ThreadbearCore

/// The Connectors panel and its icon (ConnectorsText), and the protocol
/// bits they read: `connectors.status` and `connectors.updated`
/// (docs/protocol.md, "Connectors").
final class ConnectorsTextTests: XCTestCase {
    private func status(_ json: String) throws -> ConnectorsStatus {
        try JSONDecoder().decode(ConnectorsStatus.self, from: Data(json.utf8))
    }

    func testDecodesLenientlyAndKeepsUnknownStates() throws {
        let s = try status("""
        {"state":"ok","url":"https://bruce.example.ts.net:8443","checkedAt":"2026-10-29T10:00:00.000Z","version":"0.2.0","future":1,
         "services":[{"id":"notion","title":"Notion","state":"connected","tools":14},
                     {"id":"sentry","state":"signed_out","message":"Expired","connectUrl":"https://bruce.example.ts.net:8443/admin/connect/sentry"},
                     {"id":"odd","title":"Odd","state":"half_awake"},
                     {"title":"no id"}, 3]}
        """)
        XCTAssertEqual(s.state, "ok")
        XCTAssertEqual(s.version, "0.2.0")
        XCTAssertNotNil(s.checkedAt)
        XCTAssertEqual(s.services.map(\.id), ["notion", "sentry", "odd"])
        XCTAssertEqual(s.services[1].title, "sentry", "no title: the id")
        XCTAssertEqual(ConnectorsText.stateLine(s.services[2]), "Half awake")
        let bare = try status("{}")
        XCTAssertEqual(bare.state, "checking")
        XCTAssertEqual(bare.services, [])
    }

    func testTheAccentDotOnlyForASignedOutService() {
        let out = ConnectorService(id: "sentry", title: "Sentry", state: "signed_out", connectUrl: "https://x/admin/connect/sentry")
        let fine = ConnectorService(id: "notion", title: "Notion", state: "connected")
        let broken = ConnectorService(id: "cf", title: "Cloudflare", state: "error", connectUrl: "https://x/admin/connect/cf")
        XCTAssertTrue(ConnectorsText.needsYou(ConnectorsStatus(services: [fine, out])))
        XCTAssertFalse(ConnectorsText.quiet(ConnectorsStatus(services: [fine, out])))
        XCTAssertFalse(ConnectorsText.needsYou(ConnectorsStatus(services: [fine, broken])))
        XCTAssertTrue(ConnectorsText.quiet(ConnectorsStatus(services: [fine, broken])), "an error usually sorts itself out")
        XCTAssertFalse(ConnectorsText.needsYou(ConnectorsStatus(services: [fine])))
        XCTAssertFalse(ConnectorsText.quiet(ConnectorsStatus(services: [fine])))
        // Bruce away: grey, as it isn't a sign-in.
        let away = ConnectorsStatus(state: "unreachable", url: "https://bruce.example.ts.net:8443", error: "no answer in 5 seconds")
        XCTAssertFalse(ConnectorsText.needsYou(away))
        XCTAssertTrue(ConnectorsText.quiet(away))
        XCTAssertFalse(ConnectorsText.needsYou(nil))
        XCTAssertFalse(ConnectorsText.quiet(ConnectorsStatus(state: "off")))
    }

    func testTooltipAndLines() {
        let out = ConnectorService(id: "sentry", title: "Sentry", state: "signed_out", connectUrl: "https://x/admin/connect/sentry")
        let out2 = ConnectorService(id: "gmail", title: "Gmail", state: "signed_out", connectUrl: "https://x/admin/connect/gmail")
        let fine = ConnectorService(id: "notion", title: "Notion", state: "connected")
        XCTAssertEqual(ConnectorsText.tooltip(ConnectorsStatus(services: [fine])), "Connectors\nEverything is signed in")
        XCTAssertEqual(ConnectorsText.tooltip(ConnectorsStatus(services: [out, fine])), "Connectors\nSentry needs signing in")
        XCTAssertEqual(ConnectorsText.tooltip(ConnectorsStatus(services: [out, out2])), "Connectors\nSentry and Gmail need signing in")
        let away = ConnectorsStatus(state: "unreachable", url: "https://bruce.example.ts.net:8443", error: "no answer in 5 seconds")
        XCTAssertEqual(ConnectorsText.tooltip(away), "Connectors\nCan't reach the gateway")
        XCTAssertEqual(ConnectorsText.emptyLine(away), "Can't reach bruce: no answer in 5 seconds.")
        XCTAssertEqual(ConnectorsText.emptyLine(ConnectorsStatus(state: "off")), "No Connectors gateway is set up for this runner.")
        XCTAssertNil(ConnectorsText.emptyLine(ConnectorsStatus(services: [fine])))
        XCTAssertEqual(ConnectorsText.buttonTitle(out), "Connect")
        XCTAssertNil(ConnectorsText.buttonTitle(fine))
        XCTAssertEqual(ConnectorsText.buttonTitle(ConnectorService(id: "cf", title: "Cloudflare", state: "error", connectUrl: "https://x")), "Reconnect")
        XCTAssertNil(ConnectorsText.buttonTitle(ConnectorService(id: "cf", title: "Cloudflare", state: "signed_out")), "nowhere to go, no button")
    }

    func testConnectorsUpdatedNotification() async throws {
        let transport = FakeTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        transport.push(E.json(["jsonrpc": "2.0", "method": "connectors.updated", "params": ["connectors": ["state": "ok", "services": [["id": "sentry", "title": "Sentry", "state": "signed_out"]]]]]))
        var iterator = client.notifications.makeAsyncIterator()
        guard case .connectorsUpdated(let s)? = await iterator.next() else { return XCTFail("no connectors.updated") }
        XCTAssertEqual(s.services.first?.state, "signed_out")
    }

    func testManageLinksGoToTheGatewaysOwnPages() {
        let base = "https://bruce.example.ts.net:8443"
        let fine = ConnectorService(id: "notion", title: "Notion", state: "connected")
        let out = ConnectorService(id: "sentry", title: "Sentry", state: "signed_out", connectUrl: "\(base)/admin/connect/sentry?from=x")
        let odd = ConnectorService(id: "a/b", title: "Odd", state: "connected")
        let s = ConnectorsStatus(state: "ok", url: base + "/", services: [fine, out, odd])
        XCTAssertEqual(ConnectorsText.manageURL(s)?.absoluteString, "\(base)/admin")
        XCTAssertEqual(ConnectorsText.serviceURL(s, fine)?.absoluteString, "\(base)/admin/connect/notion", "signed in: the gateway's page for it")
        XCTAssertEqual(ConnectorsText.serviceURL(s, out)?.absoluteString, "\(base)/admin/connect/sentry?from=x", "the runner's URL when it sent one")
        XCTAssertEqual(ConnectorsText.serviceURL(s, odd)?.absoluteString, "\(base)/admin/connect/a%2Fb")
        XCTAssertNil(ConnectorsText.manageURL(nil))
        XCTAssertNil(ConnectorsText.manageURL(ConnectorsStatus(state: "off")))
        XCTAssertNil(ConnectorsText.manageURL(ConnectorsStatus(state: "ok", url: "file:///etc")))
        XCTAssertNil(ConnectorsText.serviceURL(ConnectorsStatus(state: "off"), fine))
    }

    // Connectors setup and Outside agents (experiments).

    func testSetUpAndTheCatalogDecodeLenientlyAndOlderRunnersMeanNeither() throws {
        let old = try status(#"{"state":"off","services":[]}"#)
        XCTAssertFalse(old.canSetUp)
        XCTAssertEqual(old.catalog, [])
        XCTAssertFalse(ConnectorsText.showsIcon(old, agents: nil))
        let offer = try status(#"{"state":"off","services":[],"canSetUp":true}"#)
        XCTAssertTrue(ConnectorsText.showsIcon(offer, agents: nil))
        let ok = try status(#"{"state":"ok","services":[],"catalog":[{"id":"slack","title":"Slack","blurb":"b","setupNote":"n"},{"title":"no id"},{"id":"notion"}]}"#)
        XCTAssertEqual(ok.catalog.map(\.id), ["slack", "notion"])
        XCTAssertEqual(ok.catalog[1].title, "notion")
        XCTAssertEqual(ok.catalog[0].setupNote, "n")
        // Outside agents on shows the icon with no gateway at all.
        XCTAssertTrue(ConnectorsText.showsIcon(old, agents: AgentsList(on: true)))
        XCTAssertFalse(ConnectorsText.showsIcon(nil, agents: AgentsList(on: false)))
    }

    func testALocalGatewayIsThisMac() {
        XCTAssertEqual(ConnectorsText.host(ConnectorsStatus(state: "ok", url: "http://127.0.0.1:8795")), "This Mac")
        XCTAssertEqual(ConnectorsText.host(ConnectorsStatus(state: "ok", url: "http://localhost:8795")), "This Mac")
        XCTAssertEqual(ConnectorsText.host(ConnectorsStatus(state: "ok", url: "https://bruce.tail.ts.net:8443")), "bruce")
    }

    func testAgentKeysReadAsWhatTheyMayDoAndWhenLastUsed() throws {
        let list = try JSONDecoder().decode(AgentsList.self, from: Data(#"{"on":true,"url":"https://x.convex.site/mcp","keys":[{"id":"k1","name":"Grok Bot","scope":"write","readAll":false,"expiresAt":"2026-12-08T00:00:00Z","expired":false},{"name":"no id"}]}"#.utf8))
        XCTAssertEqual(list.keys.map(\.id), ["k1"])
        let key = list.keys[0]
        XCTAssertEqual(ConnectorsText.scopeLine(key), "Starts Ask threads, reads threads it started")
        XCTAssertEqual(ConnectorsText.scopeLine(AgentKey(id: "r", name: "R", readAll: true)), "Read only, reads all your threads")
        XCTAssertEqual(ConnectorsText.lastUsed(key), "Not used yet")
        let now = Date()
        let used = AgentKey(id: "u", name: "U", lastUsedAt: ISO8601DateFormatter().string(from: now.addingTimeInterval(-600)))
        XCTAssertEqual(ConnectorsText.lastUsed(used, now: now), "Used 10 minutes ago")
        XCTAssertEqual(ConnectorsText.lastUsed(AgentKey(id: "e", name: "E", expired: true)), "Expired")
    }

    /// A new key reads as Grok Bot's "Add a custom connector" form, box by
    /// box, and the header value is the whole "Bearer <key>", so nobody
    /// pastes the bare key there (8 Nov).
    func testANewKeyReadsAsGrokBotsFormWithTheWholeHeaderValue() {
        let fields = ConnectorsText.agentForm(url: "https://x.convex.site/mcp", secret: "tba_abc")
        XCTAssertEqual(fields.map(\.label), ["Name", "Type", "Server URL", "Header key", "Header value", "Client ID"])
        func field(_ label: String) -> ConnectorsText.AgentFormField { fields.first { $0.label == label }! }
        XCTAssertEqual(field("Name").value, "threadbear")
        XCTAssertEqual(field("Type").value, "Remote HTTPS")
        XCTAssertFalse(field("Type").copies)
        XCTAssertEqual(field("Server URL").value, "https://x.convex.site/mcp")
        XCTAssertEqual(field("Header key").value, "Authorization")
        XCTAssertEqual(field("Header value").value, "Bearer tba_abc")
        XCTAssertTrue(field("Header value").copies)
        XCTAssertEqual(field("Header value").shown, "Bearer tba_••••••••", "the key is copied, never shown")
        XCTAssertFalse(fields.contains { $0.shown.contains("abc") })
        XCTAssertFalse(field("Client ID").copies, "left empty, nothing to copy")
        XCTAssertEqual(fields.filter { $0.copies }.map(\.label), ["Name", "Server URL", "Header key", "Header value"])
        XCTAssertTrue(fields.allSatisfy { !$0.tip.isEmpty })
    }

    /// The panel's × hides a row and its + brings it back (8 Nov). Hiding is
    /// only how the panel looks, so a hidden service drops out of the dot
    /// and the tooltip too, and the + only offers rows that would be there.
    func testHiddenRowsLeaveThePanelAndTheDotAndComeBackFromThePlus() {
        let out = ConnectorService(id: "notion", title: "Notion", state: "signed_out", connectUrl: "https://x/admin/connect/notion")
        let broken = ConnectorService(id: "cf", title: "Cloudflare", state: "error")
        let fine = ConnectorService(id: "deepwiki", title: "DeepWiki", state: "connected")
        let status = ConnectorsStatus(state: "ok", services: [out, broken, fine],
                                      catalog: [ConnectorCatalogEntry(id: "slack", title: "Slack"), ConnectorCatalogEntry(id: "linear", title: "Linear")])
        let H = ConnectorsText.Hidden.self
        let hidden: Set = [H.service("notion"), H.service("cf"), H.catalog("slack"), H.grokBot, H.service("gone")]

        XCTAssertTrue(ConnectorsText.needsYou(status))
        XCTAssertFalse(ConnectorsText.needsYou(status, hiding: hidden), "no dot for a row Mike hid")
        XCTAssertFalse(ConnectorsText.quiet(status, hiding: hidden))
        XCTAssertEqual(ConnectorsText.tooltip(status, hiding: hidden), "Connectors\nEverything is signed in")
        XCTAssertEqual(ConnectorsText.shown(status.services, hiding: hidden).map(\.id), ["deepwiki"])
        XCTAssertEqual(ConnectorsText.shown(status.catalog, hiding: hidden).map(\.id), ["linear"])

        let on = AgentsList(on: true, url: "https://x.convex.site/mcp")
        XCTAssertEqual(H.items(hidden, status: status, agents: on).map(\.title), ["Notion", "Cloudflare", "Slack", "Grok Bot"],
                       "in the panel's order, and nothing for a service the gateway dropped")
        XCTAssertEqual(H.items(hidden, status: status, agents: AgentsList(on: false)).map(\.title), ["Notion", "Cloudflare", "Slack"])
        XCTAssertEqual(H.items([], status: status, agents: on), [])

        XCTAssertEqual(H.decode(H.encode(hidden)), hidden)
        XCTAssertEqual(H.decode(""), [])
        XCTAssertEqual(H.decode("service:a\n\n  \ncatalog:b"), ["service:a", "catalog:b"])
    }
}
