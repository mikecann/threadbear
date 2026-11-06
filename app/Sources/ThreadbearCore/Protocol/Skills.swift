import Foundation

/// A skill in Threadbear's store (docs/protocol.md, "Skills").
public struct Skill: Sendable, Hashable, Decodable, Identifiable {
    public struct Source: Sendable, Hashable, Decodable {
        /// "github" or "builtin".
        public var kind: String
        public var repo: String?
        public var ref: String?
        public var path: String?
        public var url: String?

        public init(kind: String, repo: String? = nil, ref: String? = nil, path: String? = nil, url: String? = nil) {
            self.kind = kind
            self.repo = repo
            self.ref = ref
            self.path = path
            self.url = url
        }
    }

    public var name: String
    public var description: String
    public var always: Bool
    public var source: Source
    public var commit: String
    public var dir: String
    public var addedAt: String

    public var id: String { name }

    public init(name: String, description: String, always: Bool, source: Source, commit: String, dir: String, addedAt: String = "") {
        self.name = name
        self.description = description
        self.always = always
        self.source = source
        self.commit = commit
        self.dir = dir
        self.addedAt = addedAt
    }

    /// "wheresryan22/anatomy at 1482e84", "Comes with Threadbear".
    public var sourceLine: String {
        if source.kind == "builtin" { return "Comes with Threadbear" }
        let at = commit.count >= 7 ? " at \(commit.prefix(7))" : ""
        let place = [source.repo, source.path].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "/")
        return (place.isEmpty ? "GitHub" : place) + at
    }

    /// Where the source can be seen: its GitHub page at the pinned commit.
    public var sourceURL: URL? {
        guard source.kind == "github", let repo = source.repo else { return nil }
        let path = source.path.map { "/tree/\(commit)/\($0)" } ?? "/tree/\(commit)"
        return URL(string: "https://github.com/\(repo)\(path)")
    }
}

public struct SuggestedSkill: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    public var url: String?

    public init(id: String, name: String, description: String, url: String? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.url = url
    }
}

public struct SkillsResult: Sendable, Decodable {
    public var skills: [Skill]
    public var suggested: [SuggestedSkill]?
    public var added: [String]?
}

/// A runner from before Skills answers `-32601`, which the app reads as
/// "no Skills page".
public extension RPCClient {
    func skills() async throws -> SkillsResult {
        try await call("skills.list", .object([:]), as: SkillsResult.self)
    }

    /// A GitHub link (or a page naming one), or a suggested skill's id.
    func addSkill(url: String? = nil, suggested: String? = nil) async throws -> SkillsResult {
        var params: [String: JSONValue] = [:]
        if let url { params["url"] = .string(url) }
        if let suggested { params["suggested"] = .string(suggested) }
        return try await call("skills.add", .object(params), as: SkillsResult.self)
    }

    func updateSkill(name: String, always: Bool? = nil, latest: Bool = false) async throws -> SkillsResult {
        var params: [String: JSONValue] = ["name": .string(name)]
        if let always { params["always"] = .bool(always) }
        if latest { params["latest"] = .bool(true) }
        return try await call("skills.update", .object(params), as: SkillsResult.self)
    }

    func removeSkill(name: String) async throws -> SkillsResult {
        try await call("skills.remove", .object(["name": .string(name)]), as: SkillsResult.self)
    }
}
