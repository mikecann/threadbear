import Foundation

/// How the Projects page is laid out when Settings > General > Look has
/// "Customize the Projects page" on. The page ships with no picture, so
/// there's no bear to keep: a picture of your own or none, which starts
/// as none. Then a background photo, the picture, the title and search,
/// and the cards each at the top, middle or bottom or hidden, and which
/// parts of each card show (where the Scheduled page picks its numbers).
/// Kept on this Mac (UserDefaults, as JSON), never sent to the runner;
/// every field decodes on its own, like ScheduledLook.
public struct ProjectsLook: Codable, Equatable, Sendable, PictureLook {
    public typealias Place = LibrarianLook.Place
    public typealias Picture = LibrarianLook.Picture
    public typealias PictureSize = LibrarianLook.PictureSize

    /// The parts of the page, in the order they stack within a place.
    public enum Block: String, CaseIterable, Codable, Sendable, Identifiable {
        case picture, header, cards
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .picture: "Picture"
            case .header: "Title and search"
            case .cards: "Projects"
            }
        }
    }

    /// The parts of a project's card that can go.
    public enum CardPart: String, CaseIterable, Codable, Sendable, Identifiable {
        case art, threads, status, state
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .art: "Icon tile"
            case .threads: "Open threads"
            case .status: "Status"
            case .state: "Where it's up to"
            }
        }
    }

    /// The pictures this page offers: no bear, as it never had one.
    public static let pictures: [Picture] = [.none, .own]

    public var picture: Picture = .none
    /// The own picture's file name in the looks folder.
    public var pictureFile: String?
    public var pictureSize: PictureSize = .small
    /// The background picture's file name in the looks folder; nil for none.
    public var background: String?
    public var backgroundDim: Double = 0.55
    public var backgroundFocus: BackdropFocus = .bottom
    public var places: [String: Place] = [:]
    public var hidden: Set<Block> = []
    public var hiddenCardParts: Set<CardPart> = []

    public init() {}

    public static let standard = ProjectsLook()

    public var isStandard: Bool { self == .standard }

    /// Everything starts at the top, so the standard look is the page as
    /// it ships; middle and bottom are real places in the window.
    public static func defaultPlace(_ block: Block) -> Place { .top }

    public func place(_ block: Block) -> Place { places[block.rawValue] ?? Self.defaultPlace(block) }

    public mutating func setPlace(_ place: Place, for block: Block) {
        places[block.rawValue] = place == Self.defaultPlace(block) ? nil : place
    }

    /// Shown, as the user set it. The picture is only ever your own, so it
    /// needs a file.
    public func shows(_ block: Block) -> Bool {
        guard !hidden.contains(block) else { return false }
        if block == .picture { return picture == .own && pictureFile != nil }
        return true
    }

    public mutating func setShown(_ shown: Bool, for block: Block) {
        if shown { hidden.remove(block) } else { hidden.insert(block) }
    }

    public mutating func showPicture() { setShown(true, for: .picture) }

    public func shows(_ part: CardPart) -> Bool { !hiddenCardParts.contains(part) }

    public mutating func setShown(_ shown: Bool, for part: CardPart) {
        if shown { hiddenCardParts.remove(part) } else { hiddenCardParts.insert(part) }
    }

    /// The parts to draw, top to bottom: by place, then in Block's order.
    public var layout: [Block] {
        Place.allCases.flatMap { place in Block.allCases.filter { self.place($0) == place && shows($0) } }
    }

    private enum CodingKeys: String, CodingKey {
        case picture, pictureFile, pictureSize, background, backgroundDim, backgroundFocus, places, hidden, hiddenCardParts
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // The bear isn't offered here; one saved by another build is none.
        let picture = (try? c.decode(Picture.self, forKey: .picture)) ?? .none
        self.picture = Self.pictures.contains(picture) ? picture : .none
        pictureFile = try? c.decode(String.self, forKey: .pictureFile)
        pictureSize = (try? c.decode(PictureSize.self, forKey: .pictureSize)) ?? .small
        background = try? c.decode(String.self, forKey: .background)
        backgroundDim = min(1, max(0, (try? c.decode(Double.self, forKey: .backgroundDim)) ?? 0.55))
        backgroundFocus = (try? c.decode(BackdropFocus.self, forKey: .backgroundFocus)) ?? .bottom
        // Unknown parts and places from another build are dropped, not fatal.
        let rawPlaces = (try? c.decode([String: String].self, forKey: .places)) ?? [:]
        places = rawPlaces.reduce(into: [:]) { out, pair in
            if Block(rawValue: pair.key) != nil, let place = Place(rawValue: pair.value) { out[pair.key] = place }
        }
        hidden = Set(((try? c.decode([String].self, forKey: .hidden)) ?? []).compactMap(Block.init(rawValue:)))
        hiddenCardParts = Set(((try? c.decode([String].self, forKey: .hiddenCardParts)) ?? []).compactMap(CardPart.init(rawValue:)))
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
        try c.encode(hiddenCardParts.map(\.rawValue).sorted(), forKey: .hiddenCardParts)
    }

    /// The saved look, or the standard one when nothing readable is saved.
    public static func load(_ data: Data?) -> ProjectsLook {
        guard let data, let look = try? JSONDecoder().decode(ProjectsLook.self, from: data) else { return .standard }
        return look
    }

    public func data() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
}
