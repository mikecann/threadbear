import Foundation

/// How the Scheduled page is laid out when Settings > General > Look has
/// "Customize the Scheduled page" on: the bear, a picture of your own or
/// none, a background photo, each part at the top, middle or bottom or
/// hidden, and which numbers show. Deliberately smaller than the
/// Librarian's look (no greeting, quote or activity cards): the page is
/// about what runs next. Kept on this Mac (UserDefaults, as JSON), never
/// sent to the runner; every field decodes on its own, like LibrarianLook.
public struct ScheduledLook: Codable, Equatable, Sendable, PictureLook {
    public typealias Place = LibrarianLook.Place
    public typealias Picture = LibrarianLook.Picture
    public typealias PictureSize = LibrarianLook.PictureSize

    /// The parts of the page, in the order they stack within a place.
    public enum Block: String, CaseIterable, Codable, Sendable, Identifiable {
        case picture, about, numbers
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .picture: "Picture"
            case .about: "Title and status"
            case .numbers: "Numbers"
            }
        }
    }

    public var picture: Picture = .bear
    /// The own picture's file name in the looks folder.
    public var pictureFile: String?
    public var pictureSize: PictureSize = .medium
    /// The background picture's file name in the looks folder; nil for none.
    public var background: String?
    public var backgroundDim: Double = 0.55
    public var backgroundFocus: BackdropFocus = .bottom
    public var places: [String: Place] = [:]
    public var hidden: Set<Block> = []
    /// The numbers (by their key) taken off the page.
    public var hiddenNumbers: Set<String> = []

    public init() {}

    public static let standard = ScheduledLook()

    public var isStandard: Bool { self == .standard }

    /// Where a part sits when it hasn't been moved: as the page ships.
    public static func defaultPlace(_ block: Block) -> Place {
        switch block {
        case .picture, .about: .top
        case .numbers: .middle
        }
    }

    public func place(_ block: Block) -> Place { places[block.rawValue] ?? Self.defaultPlace(block) }

    /// Moving a part back to where it starts isn't kept as a change, so
    /// the look is standard again.
    public mutating func setPlace(_ place: Place, for block: Block) {
        places[block.rawValue] = place == Self.defaultPlace(block) ? nil : place
    }

    /// Shown, as the user set it. Your picture also needs a file.
    public func shows(_ block: Block) -> Bool {
        guard !hidden.contains(block) else { return false }
        if block == .picture { return picture != .none && (picture != .own || pictureFile != nil) }
        return true
    }

    public mutating func setShown(_ shown: Bool, for block: Block) {
        if shown { hidden.remove(block) } else { hidden.insert(block) }
    }

    public mutating func showPicture() { setShown(true, for: .picture) }

    /// The parts to draw, top to bottom: by place, then in Block's order.
    public var layout: [Block] {
        Place.allCases.flatMap { place in Block.allCases.filter { self.place($0) == place && shows($0) } }
    }

    private enum CodingKeys: String, CodingKey {
        case picture, pictureFile, pictureSize, background, backgroundDim, backgroundFocus, places, hidden, hiddenNumbers
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
    }

    /// The saved look, or the standard one when nothing readable is saved.
    public static func load(_ data: Data?) -> ScheduledLook {
        guard let data, let look = try? JSONDecoder().decode(ScheduledLook.self, from: data) else { return .standard }
        return look
    }

    public func data() -> Data { (try? JSONEncoder().encode(self)) ?? Data() }
}
