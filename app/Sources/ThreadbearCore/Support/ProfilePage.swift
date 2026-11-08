import Foundation

/// The public profile page, `<site>/@<handle>` (docs/protocol.md,
/// "Profile page"): what the Librarian page's Customize panel lets you put
/// on it. The runner keeps it (profile.json) and sends only the parts
/// turned on to your Convex backend; every part starts off.
public struct ProfilePageSettings: Codable, Equatable, Sendable {
    public enum Part: String, CaseIterable, Codable, Sendable, Identifiable {
        case picture, background, activity, github, numbers, projects, memberSince
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .picture: "Picture"
            case .background: "Background photo"
            case .activity: "Threadbear activity"
            case .github: "GitHub activity"
            case .numbers: "Numbers"
            case .projects: "Projects"
            case .memberSince: "Using Threadbear since"
            }
        }

        public var tip: String {
            switch self {
            case .picture: "The Librarian page's picture: the bear or your own"
            case .background: "The Librarian page's background photo, behind the top of your page"
            case .activity: "A year of days, shaded by how many threads you started each day. Threads in a private folder aren't counted"
            case .github: "A year of your public GitHub contributions, for the user name in GitHub activity above"
            case .numbers: "The numbers you pick below. Counts only, never what a thread said"
            case .projects: "The projects you pick below: title and thread count only, never goals, state, notes or folders"
            case .memberSince: "The month of your first thread"
            }
        }
    }

    public struct Link: Codable, Equatable, Sendable, Identifiable {
        public var title: String
        public var url: String
        public var id: String { url }
        public init(title: String, url: String) {
            self.title = title
            self.url = url
        }
    }

    /// The page's numbers, as the runner works them out.
    public static let numberChoices: [(key: String, title: String)] = [
        ("threads", "Threads this year"),
        ("activeDays", "Active days"),
        ("streak", "Longest streak"),
        ("projects", "Projects"),
        ("models", "Models used"),
    ]

    public static let linksMax = 4
    public static let handleMin = 3
    public static let handleMax = 30

    public var published = false
    public var handle = ""
    public var name = ""
    public var bio = ""
    public var links: [Link] = []
    public var show: [Part] = []
    public var numbers: [String] = ["threads", "activeDays", "streak"]
    public var projectIds: [String] = []
    public var order: [String] = []
    public var picturePath: String?
    public var backgroundPath: String?
    public var backgroundDim: Double?
    public var githubUser: String?

    public init() {}

    public func shows(_ part: Part) -> Bool { show.contains(part) }

    public mutating func setShown(_ on: Bool, _ part: Part) {
        if on { if !show.contains(part) { show.append(part) } } else { show.removeAll { $0 == part } }
    }

    /// Why a handle won't do, or nil when it will.
    public static func handleProblem(_ handle: String) -> String? {
        if handle.count < handleMin { return "At least \(handleMin) characters" }
        if handle.count > handleMax { return "At most \(handleMax) characters" }
        let ok = handle.range(of: "^[a-z0-9]+(-[a-z0-9]+)*$", options: .regularExpression) != nil
        return ok ? nil : "Lowercase letters, numbers and single hyphens"
    }

    /// What's typed, as a handle: lower case, no @, no spaces.
    public static func cleanHandle(_ typed: String) -> String {
        typed.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "@", with: "").lowercased()
            .replacingOccurrences(of: " ", with: "-")
    }

    /// Why a link won't do, or nil.
    public static func linkProblem(_ url: String) -> String? {
        guard let u = URL(string: url.trimmingCharacters(in: .whitespaces)), let scheme = u.scheme?.lowercased(),
              scheme == "https" || scheme == "http", u.host?.isEmpty == false else { return "Starts with https://" }
        return nil
    }

    /// The web page's cards top to bottom, from where the Librarian page
    /// puts its parts: the numbers with Threadbear activity just under them,
    /// GitHub activity where it sits, and projects at the bottom.
    public static func cardOrder(_ look: LibrarianLook) -> [String] {
        let cards: [(String, LibrarianLook.Place, Int)] = [
            ("numbers", look.place(.numbers), 0),
            ("activity", look.place(.numbers), 1),
            ("github", look.place(.github), 2),
            ("projects", .bottom, 3),
        ]
        let rank = Dictionary(uniqueKeysWithValues: LibrarianLook.Place.allCases.enumerated().map { ($1, $0) })
        return cards.sorted { (rank[$0.1]!, $0.2) < (rank[$1.1]!, $1.2) }.map(\.0)
    }

    private enum CodingKeys: String, CodingKey {
        case published, handle, name, bio, links, show, numbers, projectIds, order, picturePath, backgroundPath, backgroundDim, githubUser
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        published = (try? c.decode(Bool.self, forKey: .published)) ?? false
        handle = (try? c.decode(String.self, forKey: .handle)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        bio = (try? c.decode(String.self, forKey: .bio)) ?? ""
        links = (try? c.decode([Link].self, forKey: .links)) ?? []
        // A part from a newer build is dropped, not fatal.
        show = ((try? c.decode([String].self, forKey: .show)) ?? []).compactMap(Part.init(rawValue:))
        numbers = (try? c.decode([String].self, forKey: .numbers)) ?? []
        projectIds = (try? c.decode([String].self, forKey: .projectIds)) ?? []
        order = (try? c.decode([String].self, forKey: .order)) ?? []
        picturePath = try? c.decode(String.self, forKey: .picturePath)
        backgroundPath = try? c.decode(String.self, forKey: .backgroundPath)
        backgroundDim = try? c.decode(Double.self, forKey: .backgroundDim)
        githubUser = try? c.decode(String.self, forKey: .githubUser)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(published, forKey: .published)
        try c.encode(handle, forKey: .handle)
        try c.encode(name, forKey: .name)
        try c.encode(bio, forKey: .bio)
        try c.encode(links, forKey: .links)
        try c.encode(show.map(\.rawValue), forKey: .show)
        try c.encode(numbers, forKey: .numbers)
        try c.encode(projectIds, forKey: .projectIds)
        try c.encode(order, forKey: .order)
        try c.encodeIfPresent(picturePath, forKey: .picturePath)
        try c.encodeIfPresent(backgroundPath, forKey: .backgroundPath)
        try c.encodeIfPresent(backgroundDim, forKey: .backgroundDim)
        try c.encodeIfPresent(githubUser, forKey: .githubUser)
    }
}

/// What `profilePage.get` and `profilePage.update` answer.
public struct ProfilePageStatus: Decodable, Equatable, Sendable {
    public var profile: ProfilePageSettings?
    /// The page's address, once there's a handle and a backend.
    public var url: String?
    public var sentAt: String?
    /// Why the last send didn't go, said by the runner or the backend.
    public var problem: String?

    public init(profile: ProfilePageSettings? = nil, url: String? = nil, sentAt: String? = nil, problem: String? = nil) {
        self.profile = profile
        self.url = url
        self.sentAt = sentAt
        self.problem = problem
    }
}
