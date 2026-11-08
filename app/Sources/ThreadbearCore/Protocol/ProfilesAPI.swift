import Foundation

/// Settings > Profiles (docs/protocol.md, "Profiles"): this Mac's profiles,
/// from whichever runner the app is on.
public struct ProfileJobInfo: Decodable, Sendable, Hashable {
    public struct Team: Decodable, Sendable, Hashable, Identifiable {
        public var name: String
        public var slug: String
        public var id: String { slug }
    }

    public var state: String
    public var lines: [String]
    public var teams: [Team]?
    public var message: String?

    public var isRunning: Bool { state == "running" }
}

public struct ProfileInfo: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var home: String
    public var port: Int
    public var label: String
    public var running: Bool
    public var convexUrl: String?
    public var job: ProfileJobInfo?

    public var isPersonal: Bool { id == Profiles.personalId }
    public var entry: ProfileEntry { ProfileEntry(id: id, name: name, home: home, port: port, label: label) }
}

public struct ProfilesResult: Decodable, Sendable { public var profiles: [ProfileInfo] }
private struct ProfileResult: Decodable, Sendable { var profile: ProfileEntry }

public extension RPCClient {
    func profiles() async throws -> [ProfileInfo] {
        try await call("profiles.list", .object([:]), as: ProfilesResult.self).profiles
    }

    /// Makes the profile and starts its setup (its Convex sign-in opens in the browser).
    @discardableResult
    func createProfile(name: String, project: String?, team: String?) async throws -> ProfileEntry {
        var params: [String: JSONValue] = ["name": .string(name)]
        if let project, !project.isEmpty { params["project"] = .string(project) }
        if let team, !team.isEmpty { params["team"] = .string(team) }
        return try await call("profiles.create", .object(params), as: ProfileResult.self, timeout: .seconds(60)).profile
    }

    func retryProfile(id: String, team: String?) async throws {
        var params: [String: JSONValue] = ["id": .string(id)]
        if let team { params["team"] = .string(team) }
        _ = try await call("profiles.retry", .object(params), as: JSONValue.self)
    }

    func renameProfile(id: String, name: String) async throws {
        _ = try await call("profiles.rename", .object(["id": .string(id), "name": .string(name)]), as: ProfileResult.self)
    }

    func removeProfile(id: String, deleteFiles: Bool) async throws {
        _ = try await call("profiles.remove", .object(["id": .string(id), "deleteFiles": .bool(deleteFiles)]), as: ProfileResult.self, timeout: .seconds(120))
    }
}
