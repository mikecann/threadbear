import Foundation

/// What the Connectors panel and its activity bar icon say about the
/// gateway's services (docs/protocol.md, "Connectors"). The accent dot
/// only when a service is signed out, as only Mike can sign it back in;
/// a grey one while the gateway can't be reached or a service is
/// connecting or in error, which usually sorts itself out (as Updates'
/// dots go, 27 Oct).
public enum ConnectorsText {
    /// Whether the activity bar has the Connectors icon: a gateway it
    /// watches, Set up on offer, or outside agents on.
    public static func showsIcon(_ s: ConnectorsStatus?, agents: AgentsList?) -> Bool {
        if let s, s.state != "off" || s.canSetUp { return true }
        return agents?.on == true
    }

    /// When a key was last used, in a few words.
    public static func lastUsed(_ k: AgentKey, now: Date = Date()) -> String {
        if k.expired { return "Expired" }
        guard let at = k.lastUsedAt.flatMap(ConnectorsStatus.parseDate) else { return "Not used yet" }
        let mins = Int(now.timeIntervalSince(at) / 60)
        if mins < 2 { return "Used just now" }
        if mins < 60 { return "Used \(mins) minutes ago" }
        if mins < 48 * 60 { return "Used \(mins / 60) hours ago" }
        return "Used \(mins / 1440) days ago"
    }

    /// What a key may do, in a few words.
    public static func scopeLine(_ k: AgentKey) -> String {
        let reads = k.readAll ? "reads all your threads" : "reads threads it started"
        return k.scope == "write" ? "Starts Ask threads, \(reads)" : "Read only, \(reads)"
    }

    /// One box of Grok Bot's "Add a custom connector" form, as the panel
    /// shows it under a new key.
    public struct AgentFormField: Equatable, Sendable {
        init(label: String, value: String, shown: String? = nil, copies: Bool, tip: String) {
            self.label = label
            self.value = value
            self.shown = shown ?? value
            self.copies = copies
            self.tip = tip
        }

        public var label: String
        /// What the copy button copies.
        public var value: String
        /// What the row shows: the value, but never the key itself, so a
        /// screenshot or a screen share doesn't give it away.
        public var shown: String
        /// Whether the row has a copy button; Type and Client ID are
        /// chosen or left empty, not pasted.
        public var copies: Bool
        public var tip: String
    }

    /// What goes in each box of Grok Bot's form for a new key. The header
    /// value is the whole "Bearer <key>": a bare key there is refused, and
    /// "give it as a bearer token" lost people (8 Nov).
    public static func agentForm(url: String, secret: String) -> [AgentFormField] {
        [
            AgentFormField(label: "Name", value: "threadbear", copies: true, tip: "Copy a name for the connector"),
            AgentFormField(label: "Type", value: "Remote HTTPS", copies: false, tip: "Pick Remote HTTPS in the menu, not Command"),
            AgentFormField(label: "Server URL", value: url, copies: true, tip: "Copy the server address"),
            AgentFormField(label: "Header key", value: "Authorization", copies: true, tip: "Copy the header name, for the left box under HTTP headers"),
            AgentFormField(label: "Header value", value: "Bearer " + secret, shown: "Bearer " + masked(secret), copies: true, tip: "Copy \"Bearer\", a space and the key, for the right box under HTTP headers"),
            AgentFormField(label: "Client ID", value: "Leave it empty", copies: false, tip: "Only for services you sign in to in a browser; the key does that here"),
        ]
    }

    /// "tba_••••••••": the key's kind, never any of its secret part.
    static func masked(_ secret: String) -> String {
        (secret.hasPrefix("tba_") ? "tba_" : "") + String(repeating: "•", count: 8)
    }

    /// The services that need Mike to sign in again, leaving out ones he
    /// hid from the panel: a dot for a row he can't see would only puzzle.
    public static func signedOut(_ s: ConnectorsStatus?, hiding hidden: Set<String> = []) -> [ConnectorService] {
        guard let s, s.state == "ok" else { return [] }
        return shown(s.services, hiding: hidden).filter { $0.state == "signed_out" }
    }

    public static func needsYou(_ s: ConnectorsStatus?, hiding hidden: Set<String> = []) -> Bool {
        !signedOut(s, hiding: hidden).isEmpty
    }

    /// The grey dot: something's off that isn't Mike's to fix yet.
    public static func quiet(_ s: ConnectorsStatus?, hiding hidden: Set<String> = []) -> Bool {
        guard let s else { return false }
        if s.state == "unreachable" { return true }
        guard s.state == "ok" else { return false }
        return shown(s.services, hiding: hidden).contains { $0.state == "error" || $0.state == "connecting" }
    }

    /// The icon's tooltip: "Connectors", then what needs a look, or that
    /// everything's signed in.
    public static func tooltip(_ s: ConnectorsStatus?, hiding hidden: Set<String> = []) -> String {
        var lines = ["Connectors"]
        switch s?.state {
        case "ok":
            let out = signedOut(s, hiding: hidden).map(\.title)
            if !out.isEmpty { lines.append(list(out) + (out.count == 1 ? " needs signing in" : " need signing in")) }
            let broken = shown(s!.services, hiding: hidden).filter { $0.state == "error" }.map(\.title)
            if !broken.isEmpty { lines.append(list(broken) + (broken.count == 1 ? " has a problem" : " have problems")) }
            if out.isEmpty && broken.isEmpty { lines.append(s!.services.isEmpty ? "No services yet" : "Everything is signed in") }
        case "unreachable":
            lines.append("Can't reach the gateway")
        case "checking":
            lines.append("Checking")
        default:
            break
        }
        return lines.joined(separator: "\n")
    }

    /// The panel's line when there are no services to list.
    public static func emptyLine(_ s: ConnectorsStatus?) -> String? {
        guard let s else { return "Checking the gateway." }
        switch s.state {
        case "off": return "No Connectors gateway is set up for this runner."
        case "checking": return "Checking the gateway."
        case "unreachable":
            let host = host(s) ?? "the gateway"
            return "Can't reach \(host)" + (s.error.map { ": \($0)." } ?? ".")
        default:
            return s.services.isEmpty ? "The gateway has no services set up." : nil
        }
    }

    /// The gateway's machine, as its owner calls it: "bruce" for
    /// bruce.example.ts.net.
    public static func host(_ s: ConnectorsStatus?) -> String? {
        guard let host = s?.url.flatMap({ URL(string: $0)?.host }), !host.isEmpty else { return nil }
        // A gateway on this Mac (what Set up makes) is "This Mac", not "127".
        if host == "localhost" || host == "::1" || host.hasPrefix("127.") { return "This Mac" }
        return host.components(separatedBy: ".").first ?? host
    }

    /// The gateway's admin page, where every service can be connected,
    /// signed out or retried, for the panel's manage button.
    public static func manageURL(_ s: ConnectorsStatus?) -> URL? {
        adminURL(s, path: "/admin")
    }

    /// One service's page on the gateway (its Connect, Disconnect or Try
    /// again), whatever its state. The runner only sends a connect URL for
    /// a service that isn't signed in, so a signed-in one gets the
    /// gateway's page for it, as the runner's own fallback does.
    public static func serviceURL(_ s: ConnectorsStatus?, _ service: ConnectorService) -> URL? {
        if let raw = service.connectUrl, let url = URL(string: raw), isWeb(url) { return url }
        let id = service.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? service.id
        return adminURL(s, path: "/admin/connect/\(id)")
    }

    private static func adminURL(_ s: ConnectorsStatus?, path: String) -> URL? {
        guard let s, s.state != "off", let raw = s.url, let base = URL(string: raw), isWeb(base),
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        parts.percentEncodedPath = path
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    private static func isWeb(_ url: URL) -> Bool {
        ["https", "http"].contains(url.scheme?.lowercased() ?? "")
    }

    /// A service's state in a word or two.
    public static func stateLine(_ service: ConnectorService) -> String {
        switch service.state {
        case "connected": return "Signed in"
        case "signed_out": return "Signed out"
        case "connecting": return "Connecting"
        case "error": return "Not working"
        case "disabled": return "Turned off"
        default: return service.state.replacingOccurrences(of: "_", with: " ").capitalizedFirst
        }
    }

    /// The button beside a service, or nil when there's nothing to press.
    public static func buttonTitle(_ service: ConnectorService) -> String? {
        guard let url = service.connectUrl, !url.isEmpty else { return nil }
        switch service.state {
        case "connected", "disabled": return nil
        case "signed_out": return "Connect"
        default: return "Reconnect"
        }
    }

    // MARK: Hiding rows

    /// The services still on show: the gateway keeps every one, and its
    /// agents still use a hidden one; only the panel leaves it out.
    public static func shown(_ services: [ConnectorService], hiding hidden: Set<String>) -> [ConnectorService] {
        services.filter { !hidden.contains(Hidden.service($0.id)) }
    }

    /// Add a service's suggestions still on show.
    public static func shown(_ catalog: [ConnectorCatalogEntry], hiding hidden: Set<String>) -> [ConnectorCatalogEntry] {
        catalog.filter { !hidden.contains(Hidden.catalog($0.id)) }
    }

    /// The rows Mike hid with their ×, kept in this Mac's defaults as one
    /// line each ("service:sentry", "catalog:slack", "agent:grok-bot"), so
    /// the panel's + can bring each back. Only how the panel looks: nothing
    /// is signed out, removed or revoked. A live agent key is never hidden,
    /// so Revoke is always in reach.
    public enum Hidden {
        public static let defaultsKey = "connectorsHidden"
        /// Connect an agent (it was Connect Grok Bot, so the id stays).
        public static let grokBot = "agent:grok-bot"

        public static func service(_ id: String) -> String { "service:\(id)" }
        public static func catalog(_ id: String) -> String { "catalog:\(id)" }

        public static func decode(_ raw: String) -> Set<String> {
            Set(raw.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
        }

        public static func encode(_ hidden: Set<String>) -> String {
            hidden.sorted().joined(separator: "\n")
        }

        public struct Item: Equatable, Sendable, Identifiable {
            public var id: String
            public var title: String
        }

        /// What the + offers to show again, in the panel's order. Only rows
        /// that would be there now: a service the gateway dropped, or Grok
        /// Bot with Outside agents off, has nothing to bring back.
        public static func items(_ hidden: Set<String>, status: ConnectorsStatus?, agents: AgentsList?) -> [Item] {
            var items: [Item] = []
            for row in status?.services ?? [] where hidden.contains(service(row.id)) {
                items.append(Item(id: service(row.id), title: row.title))
            }
            if status?.state == "ok" {
                for entry in status?.catalog ?? [] where hidden.contains(catalog(entry.id)) {
                    items.append(Item(id: catalog(entry.id), title: entry.title))
                }
            }
            if hidden.contains(grokBot), let agents, agents.on, agents.reason == nil {
                items.append(Item(id: grokBot, title: "Connect an agent"))
            }
            return items
        }
    }

    /// "Gmail", "Gmail and Notion", "Gmail, Notion and Sentry".
    static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + names.last!
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
