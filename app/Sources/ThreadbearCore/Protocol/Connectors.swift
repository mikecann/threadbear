import Foundation

/// Mike's Connectors gateway, as the runner last heard from its /health
/// (docs/protocol.md, "Connectors"): `connectors.status` and
/// `connectors.updated`. Read leniently, as the gateway's answer is still
/// changing: an unknown state is shown as it is.
public struct ConnectorsStatus: Sendable, Hashable, Decodable {
    /// ok, unreachable, off or checking.
    public var state: String
    public var url: String?
    public var checkedAt: Date?
    public var error: String?
    public var version: String?
    public var services: [ConnectorService]
    /// Connectors setup (an experiment): no gateway yet, and Set up is offered.
    public var canSetUp: Bool
    /// Connectors setup: services the gateway doesn't have yet, for Add a service.
    public var catalog: [ConnectorCatalogEntry]
    /// Local connectors (an experiment): Other local server is offered.
    public var canAddLocal: Bool

    public init(state: String = "ok", url: String? = nil, checkedAt: Date? = nil, error: String? = nil, version: String? = nil, services: [ConnectorService] = [], canSetUp: Bool = false, catalog: [ConnectorCatalogEntry] = [], canAddLocal: Bool = false) {
        self.canSetUp = canSetUp
        self.canAddLocal = canAddLocal
        self.catalog = catalog
        self.state = state
        self.url = url
        self.checkedAt = checkedAt
        self.error = error
        self.version = version
        self.services = services
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "checking"
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil
        checkedAt = ((try? c.decodeIfPresent(String.self, forKey: .checkedAt)) ?? nil).flatMap(ConnectorsStatus.parseDate)
        error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? nil
        version = (try? c.decodeIfPresent(String.self, forKey: .version)) ?? nil
        services = c.lossyArray(ConnectorService.self, forKey: .services)
        canSetUp = ((try? c.decodeIfPresent(Bool.self, forKey: .canSetUp)) ?? nil) ?? false
        catalog = c.lossyArray(ConnectorCatalogEntry.self, forKey: .catalog)
        canAddLocal = ((try? c.decodeIfPresent(Bool.self, forKey: .canAddLocal)) ?? nil) ?? false
    }

    enum CodingKeys: String, CodingKey { case state, url, checkedAt, error, version, services, canSetUp, catalog, canAddLocal }

    static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

public struct ConnectorService: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var title: String
    /// connected, signed_out, connecting, error, disabled or unknown (or a
    /// newer word).
    public var state: String
    public var message: String?
    public var connectUrl: String?
    /// Local connectors: a command the gateway runs on this Mac, with
    /// nothing to sign in to, and what to say when it isn't running.
    public var local: Bool
    public var stateNote: String?

    public init(id: String, title: String, state: String, message: String? = nil, connectUrl: String? = nil, local: Bool = false, stateNote: String? = nil) {
        self.local = local
        self.stateNote = stateNote
        self.id = id
        self.title = title
        self.state = state
        self.message = message
        self.connectUrl = connectUrl
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = ((try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? id
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil) ?? "unknown"
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil
        connectUrl = (try? c.decodeIfPresent(String.self, forKey: .connectUrl)) ?? nil
        local = ((try? c.decodeIfPresent(Bool.self, forKey: .local)) ?? nil) ?? false
        stateNote = (try? c.decodeIfPresent(String.self, forKey: .stateNote)) ?? nil
    }

    enum CodingKeys: String, CodingKey { case id, title, state, message, connectUrl, local, stateNote }
}

public struct ConnectorsResult: Sendable, Decodable {
    public var connectors: ConnectorsStatus
}

/// A service Add a service offers (runner/src/connectors-catalog.ts).
public struct ConnectorCatalogEntry: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var title: String
    public var blurb: String
    /// What it needs from you first (Slack's own app), behind the ⓘ.
    public var setupNote: String?
    /// remote (a hosted server) or local (a command run on this Mac).
    public var kind: String
    /// A local entry's command as it will run ("uvx mcp-for-blender@2.2.7").
    public var command: String?
    /// A local entry's tools that ask first, as agents see them.
    public var asks: [String]

    public var isLocal: Bool { kind == "local" }

    public init(id: String, title: String, blurb: String = "", setupNote: String? = nil, kind: String = "remote", command: String? = nil, asks: [String] = []) {
        self.kind = kind
        self.command = command
        self.asks = asks
        self.id = id
        self.title = title
        self.blurb = blurb
        self.setupNote = setupNote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = ((try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? id
        blurb = ((try? c.decodeIfPresent(String.self, forKey: .blurb)) ?? nil) ?? ""
        setupNote = (try? c.decodeIfPresent(String.self, forKey: .setupNote)) ?? nil
        kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? "remote"
        command = (try? c.decodeIfPresent(String.self, forKey: .command)) ?? nil
        asks = ((try? c.decodeIfPresent([String].self, forKey: .asks)) ?? nil) ?? []
    }

    enum CodingKeys: String, CodingKey { case id, title, blurb, setupNote, kind, command, asks }
}

/// connectors.setup and connectors.add: the thread doing it, and whether
/// it was already under way.
public struct ConnectorsStarted: Sendable, Decodable {
    public var threadId: String
    public var already: Bool?
}

/// An outside agent's key (Grok Bot), as agents.list has it. The key
/// itself is only ever in AgentConnected, once.
public struct AgentKey: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    /// read or write.
    public var scope: String
    public var readAll: Bool
    public var expiresAt: String
    public var lastUsedAt: String?
    public var expired: Bool

    public init(id: String, name: String, scope: String = "read", readAll: Bool = false, expiresAt: String = "", lastUsedAt: String? = nil, expired: Bool = false) {
        self.id = id
        self.name = name
        self.scope = scope
        self.readAll = readAll
        self.expiresAt = expiresAt
        self.lastUsedAt = lastUsedAt
        self.expired = expired
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? "Agent"
        scope = ((try? c.decodeIfPresent(String.self, forKey: .scope)) ?? nil) ?? "read"
        readAll = ((try? c.decodeIfPresent(Bool.self, forKey: .readAll)) ?? nil) ?? false
        expiresAt = ((try? c.decodeIfPresent(String.self, forKey: .expiresAt)) ?? nil) ?? ""
        lastUsedAt = (try? c.decodeIfPresent(String.self, forKey: .lastUsedAt)) ?? nil
        expired = ((try? c.decodeIfPresent(Bool.self, forKey: .expired)) ?? nil) ?? false
    }

    enum CodingKeys: String, CodingKey { case id, name, scope, readAll, expiresAt, lastUsedAt, expired }
}

/// agents.list: whether outside agents are on, why they can't be used
/// (no backend), the server address, and the keys.
public struct AgentsList: Sendable, Hashable, Decodable {
    public var on: Bool
    public var reason: String?
    public var url: String?
    public var keys: [AgentKey]

    public init(on: Bool = false, reason: String? = nil, url: String? = nil, keys: [AgentKey] = []) {
        self.on = on
        self.reason = reason
        self.url = url
        self.keys = keys
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = ((try? c.decodeIfPresent(Bool.self, forKey: .on)) ?? nil) ?? false
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil
        keys = c.lossyArray(AgentKey.self, forKey: .keys)
    }

    enum CodingKeys: String, CodingKey { case on, reason, url, keys }
}

/// agents.connect: the new key, the key itself (shown once) and the address.
public struct AgentConnected: Sendable, Decodable {
    public var key: AgentKey
    public var secret: String
    public var url: String
}

public extension RPCClient {
    func connectorsSetup() async throws -> ConnectorsStarted {
        try await call("connectors.setup", .object([:]), as: ConnectorsStarted.self)
    }

    func connectorsAdd(id: String) async throws -> ConnectorsStarted {
        try await call("connectors.add", .object(["id": .string(id)]), as: ConnectorsStarted.self)
    }

    func connectorsAdd(url: String, title: String) async throws -> ConnectorsStarted {
        try await call("connectors.add", .object(["url": .string(url), "title": .string(title)]), as: ConnectorsStarted.self)
    }

    /// Local connectors: a uvx or npx package at one exact version.
    func connectorsAdd(local: ConnectorsText.LocalServer) async throws -> ConnectorsStarted {
        try await call("connectors.add", .object(["local": .object([
            "launcher": .string(local.launcher), "package": .string(local.package),
            "version": .string(local.version), "title": .string(local.title),
        ])]), as: ConnectorsStarted.self)
    }

    func agentsList() async throws -> AgentsList {
        try await call("agents.list", .object([:]), as: AgentsList.self)
    }

    func agentsConnect(name: String, write: Bool, readAll: Bool) async throws -> AgentConnected {
        try await call("agents.connect", .object(["name": .string(name), "scope": .string(write ? "write" : "read"), "readAll": .bool(readAll)]), as: AgentConnected.self)
    }

    /// One key, or every key with nil.
    func agentsRevoke(_ id: String?) async throws -> AgentsList {
        try await call("agents.revoke", .object(id.map { ["id": .string($0)] } ?? [:]), as: AgentsList.self)
    }
}
