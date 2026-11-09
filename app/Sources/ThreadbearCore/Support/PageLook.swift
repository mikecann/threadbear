import Foundation

/// What a customizable page's picture and background are made of, so the
/// Customize panels' Picture and Background sections work on any page's
/// look (LibrarianLook, ScheduledLook) rather than being copied per page.
public protocol PictureLook: Equatable {
    var picture: LibrarianLook.Picture { get set }
    var pictureFile: String? { get set }
    var pictureSize: LibrarianLook.PictureSize { get set }
    var background: String? { get set }
    var backgroundDim: Double { get set }
    var backgroundFocus: BackdropFocus { get set }
    /// Puts the picture back on the page after it was hidden, as choosing
    /// a new one should.
    mutating func showPicture()
}

/// How the Librarian's page is laid out when Settings > General > Look
/// has "Customize the Librarian page" on: which picture it shows, a
/// background picture behind it, where each part sits (top, middle or
/// bottom) and which parts and numbers show. Kept on this Mac
/// (UserDefaults, as JSON), never sent to the runner. Every field decodes
/// on its own, so a look saved by an older or newer build still loads.
public struct LibrarianLook: Codable, Equatable, Sendable, PictureLook {
    /// The parts of the page, in the order they stack within a place.
    public enum Block: String, CaseIterable, Codable, Sendable, Identifiable {
        case greeting, picture, about, quote, numbers, activity, github, settings
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .greeting: "Greeting"
            case .picture: "Picture"
            case .about: "Title and status"
            case .quote: "Quote of the day"
            case .numbers: "Numbers"
            // Short enough for its row in Layout; the card says Threadbear activity.
            case .activity: "Thread activity"
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
    /// Which part of the background shows when the window crops it:
    /// bottom centre unless moved, so the photo's bottom edge sits on the
    /// window's.
    public var backgroundFocus: BackdropFocus = .bottom
    public var places: [String: Place] = [:]
    public var hidden: Set<Block> = []
    /// The numbers (by their label's id) taken off the page.
    public var hiddenNumbers: Set<String> = []
    /// Whose public GitHub contributions the GitHub block shows.
    public var githubUser: String = ""
    /// The greeting at the top ("Good morning, Wayne") and the date and
    /// time under it. Off until turned on, so a look saved before it
    /// existed doesn't grow one.
    public var greetingShown = false
    /// Who the greeting names; empty says just "Good morning".
    public var greetingName: String = ""
    public var greetingClock = true
    /// The title, the line under it and the status line, each of which
    /// can go while the others stay.
    public var hiddenAbout: Set<AboutPart> = []
    /// A quote a day (Quotes). Off until turned on, like the greeting.
    public var quoteShown = false
    /// The day the refresh button was last used, and how many times, so
    /// the skips last the day and start again the next.
    public var quoteDay: String = ""
    public var quoteSkips = 0
    /// A year of the threads you started (ThreadActivity). Off until
    /// turned on, like the greeting.
    public var activityShown = false
    /// A View profile page button beside Customize, while the profile page
    /// is published. On unless turned off; there's no button until then.
    public var profileButton = true

    /// How far today's quote has been moved on.
    public func quoteSkips(on day: String) -> Int { quoteDay == day ? quoteSkips : 0 }

    /// The refresh button: another quote for the rest of today.
    public mutating func skipQuote(on day: String) {
        quoteSkips = quoteSkips(on: day) + 1
        quoteDay = day
    }

    /// The parts of the title block.
    public enum AboutPart: String, CaseIterable, Codable, Sendable, Identifiable {
        case title, line, status
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .title: "Title"
            case .line: "Description"
            case .status: "Status"
            }
        }
    }

    public func shows(_ part: AboutPart) -> Bool { !hiddenAbout.contains(part) }

    public mutating func setShown(_ shown: Bool, for part: AboutPart) {
        if shown { hiddenAbout.remove(part) } else { hiddenAbout.insert(part) }
    }

    public init() {}

    public mutating func showPicture() { setShown(true, for: .picture) }

    public static let standard = LibrarianLook()

    /// Where a part sits when it hasn't been moved: as the page was before
    /// it could be customized, with GitHub under the numbers.
    public static func defaultPlace(_ block: Block) -> Place {
        switch block {
        case .greeting, .picture, .about, .quote: .top
        case .numbers, .activity, .github: .middle
        case .settings: .bottom
        }
    }

    /// Threadbear activity goes with the numbers until it's moved on its
    /// own, as the profile page always had it just under them.
    public func place(_ block: Block) -> Place {
        if let place = places[block.rawValue] { return place }
        return block == .activity ? place(.numbers) : Self.defaultPlace(block)
    }

    public mutating func setPlace(_ place: Place, for block: Block) {
        if block == .activity {
            places[block.rawValue] = place
            return
        }
        places[block.rawValue] = place == Self.defaultPlace(block) ? nil : place
    }

    /// Shown, as the user set it. GitHub also needs a user name.
    public func shows(_ block: Block) -> Bool {
        if block == .greeting { return greetingShown }
        if block == .quote { return quoteShown }
        if block == .activity { return activityShown }
        guard !hidden.contains(block) else { return false }
        if block == .about { return hiddenAbout.count < AboutPart.allCases.count }
        if block == .github { return !GitHubUser.clean(githubUser).isEmpty }
        if block == .picture { return picture != .none && (picture != .own || pictureFile != nil) }
        return true
    }

    public mutating func setShown(_ shown: Bool, for block: Block) {
        if block == .greeting {
            greetingShown = shown
            return
        }
        if block == .quote {
            quoteShown = shown
            return
        }
        if block == .activity {
            activityShown = shown
            return
        }
        if shown { hidden.remove(block) } else { hidden.insert(block) }
    }

    /// The parts to draw, top to bottom: by place, then in Block's order.
    public var layout: [Block] {
        Place.allCases.flatMap { place in Block.allCases.filter { self.place($0) == place && shows($0) } }
    }

    public var isStandard: Bool { self == .standard }

    private enum CodingKeys: String, CodingKey {
        case picture, pictureFile, pictureSize, background, backgroundDim, backgroundFocus, places, hidden, hiddenNumbers, githubUser, greetingShown, greetingName, greetingClock, hiddenAbout, quoteShown, quoteDay, quoteSkips, activityShown, profileButton
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        picture = (try? c.decode(Picture.self, forKey: .picture)) ?? .bear
        pictureFile = try? c.decode(String.self, forKey: .pictureFile)
        pictureSize = (try? c.decode(PictureSize.self, forKey: .pictureSize)) ?? .medium
        background = try? c.decode(String.self, forKey: .background)
        backgroundDim = min(1, max(0, (try? c.decode(Double.self, forKey: .backgroundDim)) ?? 0.55))
        backgroundFocus = (try? c.decode(BackdropFocus.self, forKey: .backgroundFocus)) ?? .bottom
        // Unknown parts and places from another build are dropped, not fatal.
        let rawPlaces = (try? c.decode([String: String].self, forKey: .places)) ?? [:]
        places = rawPlaces.reduce(into: [:]) { out, pair in
            if Block(rawValue: pair.key) != nil, let place = Place(rawValue: pair.value) { out[pair.key] = place }
        }
        hidden = Set(((try? c.decode([String].self, forKey: .hidden)) ?? []).compactMap(Block.init(rawValue:)))
        hiddenNumbers = Set((try? c.decode([String].self, forKey: .hiddenNumbers)) ?? [])
        githubUser = (try? c.decode(String.self, forKey: .githubUser)) ?? ""
        greetingShown = (try? c.decode(Bool.self, forKey: .greetingShown)) ?? false
        greetingName = (try? c.decode(String.self, forKey: .greetingName)) ?? ""
        greetingClock = (try? c.decode(Bool.self, forKey: .greetingClock)) ?? true
        quoteShown = (try? c.decode(Bool.self, forKey: .quoteShown)) ?? false
        quoteDay = (try? c.decode(String.self, forKey: .quoteDay)) ?? ""
        quoteSkips = max(0, (try? c.decode(Int.self, forKey: .quoteSkips)) ?? 0)
        activityShown = (try? c.decode(Bool.self, forKey: .activityShown)) ?? false
        profileButton = (try? c.decode(Bool.self, forKey: .profileButton)) ?? true
        hiddenAbout = Set(((try? c.decode([String].self, forKey: .hiddenAbout)) ?? []).compactMap(AboutPart.init(rawValue:)))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(picture, forKey: .picture)
        try c.encodeIfPresent(pictureFile, forKey: .pictureFile)
        try c.encode(pictureSize, forKey: .pictureSize)
        try c.encodeIfPresent(background, forKey: .background)
        try c.encode(backgroundDim, forKey: .backgroundDim)
        try c.encode(backgroundFocus, forKey: .backgroundFocus)
        try c.encode(places.mapValues(\.rawValue), forKey: .places)
        try c.encode(hidden.map(\.rawValue).sorted(), forKey: .hidden)
        try c.encode(hiddenNumbers.sorted(), forKey: .hiddenNumbers)
        try c.encode(githubUser, forKey: .githubUser)
        try c.encode(greetingShown, forKey: .greetingShown)
        try c.encode(greetingName, forKey: .greetingName)
        try c.encode(greetingClock, forKey: .greetingClock)
        try c.encode(quoteShown, forKey: .quoteShown)
        try c.encode(quoteDay, forKey: .quoteDay)
        try c.encode(quoteSkips, forKey: .quoteSkips)
        try c.encode(activityShown, forKey: .activityShown)
        try c.encode(profileButton, forKey: .profileButton)
        try c.encode(hiddenAbout.map(\.rawValue).sorted(), forKey: .hiddenAbout)
    }

    /// The saved look, or the standard one when nothing (or nothing
    /// readable) is saved.
    public static func load(_ data: Data?) -> LibrarianLook {
        guard let data, let look = try? JSONDecoder().decode(LibrarianLook.self, from: data) else { return .standard }
        return look
    }

    public func data() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
}

/// What the Librarian page's greeting says for the time on this Mac, as
/// Claude greets you: morning from 5, afternoon from 12, evening from 17,
/// night from 22 until 5.
public enum Greeting {
    public enum Part: String, Sendable { case morning, afternoon, evening, night }

    public static func part(hour: Int) -> Part {
        switch hour {
        case 5..<12: .morning
        case 12..<17: .afternoon
        case 17..<22: .evening
        default: .night
        }
    }

    /// "Good morning, Wayne", or "Good morning" with no name. A name is
    /// trimmed and kept to its first 40 characters.
    public static func text(hour: Int, name: String) -> String {
        let hello = "Good \(part(hour: hour).rawValue)"
        let name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        return name.isEmpty ? hello : "\(hello), \(name)"
    }

    /// The first word of the Mac account's full name ("Wayne Sutton" is
    /// Wayne), what the greeting suggests before you type one.
    public static func firstName(_ fullName: String) -> String {
        fullName.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
    }
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

    /// What to say when a year couldn't be fetched. Only a real "no such
    /// user" says the name is wrong; the service timing out on GitHub
    /// ("GitHub: Gateway timeout.", 8 Nov) or any other trouble says to try
    /// again, as the name is likely fine.
    public static func failure(status: Int, serviceMessage: String?, user: String) -> String {
        let message = (serviceMessage ?? "").lowercased()
        if status == 404 || message.contains("not found") || message.contains("no user") || message.contains("does not exist") {
            return "GitHub has no user called \(GitHubUser.clean(user))."
        }
        return "GitHub isn't answering right now. Try again in a few minutes."
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

/// Where a background photo sits when it fills a space of another shape
/// and is cropped: 0...1 across and down, as with a unit point. (0.5, 1)
/// keeps the photo's bottom edge on the space's bottom edge, centred.
public struct BackdropFocus: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = Self.clamp(x)
        self.y = Self.clamp(y)
    }

    public static let bottom = BackdropFocus(x: 0.5, y: 1)

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(x: (try? c.decode(Double.self, forKey: .x)) ?? 0.5, y: (try? c.decode(Double.self, forKey: .y)) ?? 1)
    }

    private enum CodingKeys: String, CodingKey { case x, y }

    private static func clamp(_ v: Double) -> Double { v.isFinite ? min(1, max(0, v)) : 0.5 }

    /// The photo's frame, scaled to fill `space` (as aspect-fill does) and
    /// shifted so the focus point lines up: 0 puts the photo's left (or
    /// top) edge on the space's, 1 its right (or bottom) edge on the
    /// space's. Along the side that already fits, the photo can't move.
    public func frame(image: CGSize, in space: CGSize) -> CGRect {
        guard image.width > 0, image.height > 0, space.width > 0, space.height > 0 else {
            return CGRect(origin: .zero, size: space)
        }
        let scale = max(space.width / image.width, space.height / image.height)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGRect(x: (space.width - size.width) * x, y: (space.height - size.height) * y,
                      width: size.width, height: size.height)
    }

    /// The focus after dragging the photo by `translation` (in the space's
    /// points) from `start`: the photo follows the pointer, and stops at
    /// its edges.
    public static func dragged(from start: BackdropFocus, by translation: CGSize, image: CGSize, in space: CGSize) -> BackdropFocus {
        let frame = start.frame(image: image, in: space)
        let spareX = frame.width - space.width
        let spareY = frame.height - space.height
        return BackdropFocus(x: spareX > 0.5 ? start.x - Double(translation.width / spareX) : start.x,
                             y: spareY > 0.5 ? start.y - Double(translation.height / spareY) : start.y)
    }
}
