import AppKit
import Observation
import SwiftUI
import ThreadbearCore

/// Pictures of the user's own on Threadbear's pages: the Librarian page's
/// picture and background (Customize the Librarian page) and the main
/// window's background behind a new thread. Both are Settings > General >
/// Look switches, off by default, kept on this Mac (UserDefaults) and
/// never sent to the runner. Chosen pictures are copied into the data
/// folder's `looks/`, scaled down, so moving or deleting the original
/// doesn't break the page; replacing or removing one deletes its copy.
@MainActor
enum Looks {
    /// Settings > General > Look: "Customize the Librarian page".
    static let librarianOnKey = "librarianLookOn"
    /// The Librarian page's LibrarianLook, as JSON.
    static let librarianKey = "librarianLook"
    /// Settings > General > Look: "Background picture in the main window".
    static let mainBackgroundOnKey = "mainBackgroundOn"
    /// The main window background's file name in `looks/`.
    static let mainBackgroundKey = "mainBackground"
    static let mainBackgroundDimKey = "mainBackgroundDim"
    /// Behind open threads' transcripts too, not only a new thread.
    static let mainBackgroundEverywhereKey = "mainBackgroundEverywhere"
    static let defaultDim = 0.55

    private static let realApp = "com.mikerosoft.threadbear"

    /// In the profile's data folder, so Work's pictures are never
    /// Personal's. A debug or scripted copy keeps its own in temp.
    static var folder: URL {
        let id = Bundle.main.bundleIdentifier ?? "unknown"
        if id == realApp { return RunnerConfig.dataDir().appendingPathComponent("looks", isDirectory: true) }
        return FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-looks-\(id)", isDirectory: true)
    }

    // MARK: The Librarian page's look

    static func librarianLook(_ defaults: UserDefaults = .standard) -> LibrarianLook {
        LibrarianLook.load(defaults.data(forKey: librarianKey))
    }

    static func saveLibrarianLook(_ look: LibrarianLook, _ defaults: UserDefaults = .standard) {
        let old = librarianLook(defaults)
        defaults.set(look.data(), forKey: librarianKey)
        // A picture the look no longer uses goes with it.
        for file in [old.pictureFile, old.background].compactMap({ $0 }) where file != look.pictureFile && file != look.background {
            remove(file)
        }
    }

    // MARK: Files

    /// Copies a picture in, scaled so its longest side is at most
    /// `maxSide` pixels. A picture with see-through parts stays a PNG; a
    /// photo becomes a JPEG. Nil when it isn't a picture macOS can read.
    static func importPicture(from url: URL, maxSide: CGFloat, prefix: String) -> String? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let image = NSImage(contentsOf: url),
              let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let scale = min(1, maxSide / CGFloat(max(source.width, source.height)))
        let width = max(1, Int(CGFloat(source.width) * scale))
        let height = max(1, Int(CGFloat(source.height) * scale))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        context.cgContext.interpolationQuality = .high
        context.cgContext.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        let alpha = source.alphaInfo
        let seeThrough = !(alpha == .none || alpha == .noneSkipLast || alpha == .noneSkipFirst)
        let (data, ext): (Data?, String) = seeThrough
            ? (rep.representation(using: .png, properties: [:]), "png")
            : (rep.representation(using: .jpeg, properties: [.compressionFactor: 0.88]), "jpg")
        guard let data else { return nil }
        let name = "\(prefix)-\(UUID().uuidString.prefix(8).lowercased()).\(ext)"
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: folder.appendingPathComponent(name), options: .atomic)
        } catch {
            AppLog.write("looks", "couldn't save a picture: \(error.localizedDescription)")
            return nil
        }
        return name
    }

    private static var cache: [String: NSImage] = [:]

    /// A picture in `looks/`, read once. Names are never reused (each copy
    /// gets a new one), so nothing in the cache goes stale.
    static func image(_ name: String?) -> NSImage? {
        guard let name, !name.isEmpty, !name.contains("/") else { return nil }
        if let image = cache[name] { return image }
        guard let image = NSImage(contentsOf: folder.appendingPathComponent(name)) else { return nil }
        cache[name] = image
        return image
    }

    static func remove(_ name: String?) {
        guard let name, !name.isEmpty, !name.contains("/") else { return }
        cache[name] = nil
        try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
    }

    /// An open panel for one picture. Nil when cancelled.
    static func choosePicture(prompt: String) -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.image]
        panel.prompt = prompt
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// A picture filling the space behind a page, with the window's own colour
/// laid over it (`dim`) so the text on top stays readable in light and
/// dark. Draws nothing when the picture's gone.
struct BackdropPicture: View {
    let image: NSImage
    let dim: Double

    var body: some View {
        GeometryReader { proxy in
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fill)
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                .overlay(Color(nsColor: .windowBackgroundColor).opacity(dim))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Whether a page has a picture behind it, so its tiles and cards switch
/// from a faint fill to a frosted one that reads over a photo.
private struct OnPictureKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var onPicture: Bool {
        get { self[OnPictureKey.self] }
        set { self[OnPictureKey.self] = newValue }
    }
}

extension View {
    /// A tile or card's fill: faint on the plain page, frosted over a picture.
    @ViewBuilder func tileBackground(_ onPicture: Bool, radius: CGFloat) -> some View {
        if onPicture {
            background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        } else {
            background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
    }
}

/// Someone's public GitHub contributions, a year at a time, for the
/// Librarian page's GitHub block. One shared copy, so moving between pages
/// doesn't fetch again; a year is fetched again after an hour (the current
/// one) or never (past years, which don't change).
@MainActor @Observable
final class GitHubActivity {
    static let shared = GitHubActivity()

    enum State: Equatable {
        case loading
        case loaded(GitHubContributions)
        case failed(String)
    }

    private(set) var states: [String: State] = [:]
    @ObservationIgnored private var fetchedAt: [String: Date] = [:]
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var session: URLSession = .shared

    static func key(_ user: String, _ year: Int) -> String { "\(GitHubUser.clean(user).lowercased())/\(year)" }

    func state(user: String, year: Int) -> State? { states[Self.key(user, year)] }

    func load(user: String, year: Int, force: Bool = false) {
        let key = Self.key(user, year)
        guard let url = GitHubContributions.url(user: user, year: year), tasks[key] == nil else { return }
        let thisYear = Calendar.current.component(.year, from: Date())
        if !force, case .loaded = states[key] {
            if year < thisYear { return }
            if let at = fetchedAt[key], Date().timeIntervalSince(at) < 3600 { return }
        }
        if states[key] == nil || force { states[key] = .loading }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let session = self.session
        tasks[key] = Task { [weak self] in
            let result: State
            do {
                let (data, response) = try await session.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 200
                do {
                    result = .loaded(try GitHubContributions.parse(data, year: year))
                } catch GitHubContributions.ParseError.service {
                    result = .failed("GitHub has no user called \(GitHubUser.clean(user)).")
                } catch {
                    result = .failed(status == 200 ? "GitHub's answer couldn't be read." : "GitHub answered \(status). Try again in a bit.")
                }
            } catch {
                result = .failed("Couldn't reach GitHub: \(error.localizedDescription)")
            }
            guard let self else { return }
            self.tasks[key] = nil
            // A refresh that fails keeps what was already showing.
            if case .failed = result, case .loaded = self.states[key] { return }
            self.states[key] = result
            if case .loaded = result { self.fetchedAt[key] = Date() }
        }
    }
}
