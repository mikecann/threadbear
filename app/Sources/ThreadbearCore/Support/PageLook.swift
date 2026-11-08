import Foundation

/// How the Librarian's page is laid out when Settings > General > Look
/// has "Customize the Librarian page" on: which picture it shows, a
/// background picture behind it, where each part sits (top, middle or
/// bottom) and which parts and numbers show. Kept on this Mac
/// (UserDefaults, as JSON), never sent to the runner. Every field decodes
/// on its own, so a look saved by an older or newer build still loads.
public struct LibrarianLook: Codable, Equatable, Sendable {
    /// The parts of the page, in the order they stack within a place.
    public enum Block: String, CaseIterable, Codable, Sendable, Identifiable {
        case picture, about, numbers, github, settings
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .picture: "Picture"
            case .about: "Name and status"
            case .numbers: "Numbers"
            case .github: "GitHub activity"
            case .settings: "Settings"
            }
        }
    }

    public enum Place: String, CaseIterable, Codable, Sendable, Identifiable {
        case top, middle, bottom
        public var id: String { rawValue }
        public var title: String { rawValue.capitalized }
    }

    public enum Picture: String, CaseIterable, Codable, Sendable, Identifiable {
        /// The librarian bear at its card catalogue, as shipped.
        case bear
        /// A picture of the user's own, copied into the data folder.
        case own
        case none
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .bear: "The bear"
            case .own: "Your picture"
            case .none: "None"
            }
        }
    }

    public enum PictureSize: String, CaseIterable, Codable, Sendable, Identifiable {
        case small, medium, large
        public var id: String { rawValue }
        public var title: String { rawValue.capitalized }
        /// The picture's largest side, before zoom.
        public var side: Double {
            switch self {
            case .small: 160
            case .medium: 280
            case .large: 400
            }
        }
    }

    public var picture: Picture = .bear
    /// The own picture's file name in the looks folder.
    public var pictureFile: String?
    public var pictureSize: PictureSize = .medium
    /// The background picture's file name in the looks folder; nil for none.
    public var background: String?
    /// How much of the window's own colour lies over the background, so
    /// text stays readable in light and dark. 0 is the photo as it is.
    public var backgroundDim: Double = 0.55
    public var places: [String: Place] = [:]
    public var hidden: Set<Block> = []
    /// The numbers (by their label's id) taken off the page.
    public var hiddenNumbers: Set<String> = []
    /// Whose public GitHub contributions the GitHub block shows.
    public var githubUser: String = ""

    public init() {}

    public static let standard = LibrarianLook()

    /// Where a part sits when it hasn't been moved: as the page was before
    /// it could be customized, with GitHub under the numbers.
    public static func defaultPlace(_ block: Block) -> Place {
        switch block {
        case .picture, .about: .top
        case .numbers, .github: .middle
        case .settings: .bottom
        }
    }

    public func place(_ block: Block) -> Place { places[block.rawValue] ?? Self.defaultPlace(block) }

    public mutating func setPlace(_ place: Place, for block: Block) {
        places[block.rawValue] = place == Self.defaultPlace(block) ? nil : place
    }

    /// Shown, as the user set it. GitHub also needs a user name.
    public func shows(_ block: Block) -> Bool {
        guard !hidden.contains(block) else { return false }
        if block == .github { return !GitHubUser.clean(githubUser).isEmpty }
        if block == .picture { return picture != .none && (picture != .own || pictureFile != nil) }
        return true
    }

    public mutating func setShown(_ shown: Bool, for block: Block) {
        if shown { hidden.remove(block) } else { hidden.insert(block) }
    }

    /// The parts to draw, top to bottom: by place, then in Block's order.
    public var layout: [Block] {
        Place.allCases.flatMap { place in Block.allCases.filter { self.place($0) == place && shows($0) } }
    }

    public var isStandard: Bool { self == .standard }

    private enum CodingKeys: String, CodingKey {
        case picture, pictureFile, pictureSize, background, backgroundDim, places, hidden, hiddenNumbers, githubUser
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        picture = (try? c.decode(Picture.self, forKey: .picture)) ?? .bear
        pictureFile = try? c.decode(String.self, forKey: .pictureFile)
        pictureSize = (try? c.decode(PictureSize.self, forKey: .pictureSize)) ?? .medium
        background = try? c.decode(String.self, forKey: .background)
        backgroundDim = min(1, max(0, (try? c.decode(Double.self, forKey: .backgroundDim)) ?? 0.55))
        // Unknown parts and places from another build are dropped, not fatal.
        let rawPlaces = (try? c.decode([String: String].self, forKey: .places)) ?? [:]
        places = rawPlaces.reduce(into: [:]) { out, pair in
            if Block(rawValue: pair.key) != nil, let place = Place(rawValue: pair.value) { out[pair.key] = place }
        }
        hidden = Set(((try? c.decode([String].self, forKey: .hidden)) ?? []).compactMap(Block.init(rawValue:)))
        hiddenNumbers = Set((try? c.decode([String].self, forKey: .hiddenNumbers)) ?? [])
        githubUser = (try? c.decode(String.self, forKey: .githubUser)) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(picture, forKey: .picture)
        try c.encodeIfPresent(pictureFile, forKey: .pictureFile)
        try c.encode(pictureSize, forKey: .pictureSize)
        try c.encodeIfPresent(background, forKey: .background)
        try c.encode(backgroundDim, forKey: .backgroundDim)
        try c.encode(places.mapValues(\.rawValue), forKey: .places)
        try c.encode(hidden.map(\.rawValue).sorted(), forKey: .hidden)
        try c.encode(hiddenNumbers.sorted(), forKey: .hiddenNumbers)
        try c.encode(githubUser, forKey: .githubUser)
    }

    /// The saved look, or the standard one when nothing (or nothing
    /// readable) is saved.
    public static func load(_ data: Data?) -> LibrarianLook {
        guard let data, let look = try? JSONDecoder().decode(LibrarianLook.self, from: data) else { return .standard }
        return look
    }

    public func data() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
}

public enum GitHubUser {
    /// A user name as typed or pasted: an @, a profile link or spaces
    /// taken off. GitHub's own rule: letters, digits and single hyphens,
    /// at most 39. Anything else is empty, so nothing odd goes in a URL.
    public static func clean(_ typed: String) -> String {
        var name = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = name.range(of: "github.com/", options: .caseInsensitive) {
            name = String(name[range.upperBound...])
        }
        name = name.split(separator: "/").first.map(String.init) ?? ""
        if name.hasPrefix("@") { name.removeFirst() }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-"))
        guard !name.isEmpty, name.count <= 39, name.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }),
              !name.hasPrefix("-"), !name.hasSuffix("-"), !name.contains("--") else { return "" }
        return name
    }
}

/// One year of someone's public GitHub contributions, from the GitHub
/// Contributions API (github-contributions-api.jogruber.de), which reads
/// the calendar on their GitHub profile. No token, and only the user name
/// is sent.
public struct GitHubContributions: Equatable, Sendable {
    public struct Day: Equatable, Sendable {
        /// yyyy-MM-dd.
        public let date: String
        public let count: Int
        /// 0 (none) to 4 (most), as GitHub shades it.
        public let level: Int

        public init(date: String, count: Int, level: Int) {
            self.date = date
            self.count = count
            self.level = level
        }
    }

    public let year: Int
    public let total: Int
    public let days: [Day]

    public init(year: Int, total: Int, days: [Day]) {
        self.year = year
        self.total = total
        self.days = days
    }

    public static func url(user: String, year: Int) -> URL? {
        let name = GitHubUser.clean(user)
        guard !name.isEmpty else { return nil }
        return URL(string: "https://github-contributions-api.jogruber.de/v4/\(name)?y=\(year)")
    }

    private struct Wire: Decodable {
        struct WireDay: Decodable {
            let date: String
            let count: Int
            let level: Int
        }
        let total: [String: Int]?
        let contributions: [WireDay]?
    }

    public enum ParseError: Error, Equatable {
        case unreadable
        /// The service's own error, such as an unknown user.
        case service(String)
    }

    public static func parse(_ data: Data, year: Int) throws -> GitHubContributions {
        if let error = try? JSONDecoder().decode([String: String].self, from: data), let message = error["error"] {
            throw ParseError.service(message)
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: data), let list = wire.contributions else {
            throw ParseError.unreadable
        }
        let prefix = "\(year)-"
        let days = list.filter { $0.date.hasPrefix(prefix) }
            .map { Day(date: $0.date, count: max(0, $0.count), level: min(4, max(0, $0.level))) }
            .sorted { $0.date < $1.date }
        let total = wire.total?["\(year)"] ?? days.reduce(0) { $0 + $1.count }
        return GitHubContributions(year: year, total: total, days: days)
    }

    /// The calendar as GitHub draws it: a column per week, Sunday at the
    /// top, every day of the year in place (a day the service didn't send
    /// counts as none), and nil before the 1st and after the 31st.
    public func weeks(calendar: Calendar = GitHubContributions.gregorian) -> [[Day?]] {
        guard let first = calendar.date(from: DateComponents(year: year, month: 1, day: 1)),
              let next = calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1)) else { return [] }
        let byDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
        var weeks: [[Day?]] = []
        var week: [Day?] = Array(repeating: nil, count: calendar.component(.weekday, from: first) - 1)
        var date = first
        while date < next {
            let key = Self.key(date, calendar: calendar)
            week.append(byDate[key] ?? Day(date: key, count: 0, level: 0))
            if week.count == 7 {
                weeks.append(week)
                week = []
            }
            date = calendar.date(byAdding: .day, value: 1, to: date) ?? next
        }
        if !week.isEmpty { weeks.append(week + Array(repeating: nil, count: 7 - week.count)) }
        return weeks
    }

    /// Each month's short name and the week column its 1st falls in.
    public func monthStarts(calendar: Calendar = GitHubContributions.gregorian) -> [(month: String, week: Int)] {
        let weeks = self.weeks(calendar: calendar)
        let names = calendar.shortMonthSymbols
        var starts: [(String, Int)] = []
        for (index, week) in weeks.enumerated() {
            for day in week.compactMap({ $0 }) where day.date.hasSuffix("-01") {
                let month = Int(day.date.dropFirst(5).prefix(2)) ?? 1
                starts.append((names[month - 1], index))
            }
        }
        return starts
    }

    public static let gregorian: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    static func key(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
