import Foundation

/// Profiles (docs/guide.md, "Profiles"): whole Threadbear setups side by
/// side on one Mac, such as Work beside Personal, each with its own runner,
/// data folder, Convex and logins. The runner keeps the list in
/// `profiles.json` in Personal's folder (runner/src/profiles.ts); this
/// reads it. The app shows one profile at a time and switches by opening
/// itself again on the other one's folder.
public struct ProfileEntry: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var home: String
    public var port: Int
    public var label: String

    public init(id: String, name: String, home: String, port: Int, label: String) {
        self.id = id
        self.name = name
        self.home = home
        self.port = port
        self.label = label
    }

    public var isPersonal: Bool { id == Profiles.personalId }
    public var homeURL: URL { URL(fileURLWithPath: home, isDirectory: true) }
}

public enum Profiles {
    public static let personalId = "personal"
    /// The profile the installed app opens on (its folder); none is Personal.
    public static let savedHomeKey = "profileHome"

    private struct File: Decodable { var profiles: [ProfileEntry] }

    /// Every profile, Personal first, from `profiles.json` in `base`.
    public static func all(base: URL = RunnerConfig.defaultDataDir) -> [ProfileEntry] {
        let personal = ProfileEntry(id: personalId, name: "Personal", home: base.path, port: RunnerConfig.port(dataDir: base), label: RunnerConfig.launchdLabel)
        guard let data = try? Data(contentsOf: base.appendingPathComponent("profiles.json")),
              let file = try? JSONDecoder().decode(File.self, from: data) else { return [personal] }
        return [personal] + file.profiles.filter { !$0.id.isEmpty && $0.id != personalId && !$0.home.isEmpty }
    }

    /// The profile whose folder `dataDir` is, if any.
    public static func entry(for dataDir: URL, in list: [ProfileEntry]) -> ProfileEntry? {
        let path = standard(dataDir)
        return list.first { standard($0.homeURL) == path }
    }

    static func standard(_ url: URL) -> String { url.resolvingSymlinksInPath().standardizedFileURL.path }

    /// A setting's key in this profile: Personal keeps the plain key (as
    /// before profiles), any other profile its own copy.
    public static func scoped(_ key: String, profileId: String?) -> String {
        guard let profileId, profileId != personalId else { return key }
        return "profile.\(profileId).\(key)"
    }

    /// The colours a profile can have, by name. Personal has none unless
    /// one is picked, so a Mac with one profile looks as it always did.
    public static let colours = ["blue", "orange", "green", "purple", "pink", "teal", "red", "yellow"]

    /// A profile's colour: the one picked, else one from its place in the list.
    public static func colour(of entry: ProfileEntry, picked: String?, index: Int) -> String? {
        if let picked, colours.contains(picked) { return picked }
        if entry.isPersonal { return nil }
        // The second profile is orange, the third green and so on: never
        // Personal's blue unless picked.
        return colours[max(index, 1) % colours.count]
    }
}

extension RunnerConfig {
    /// The port in a data folder's runner.json, else the default.
    public static func port(dataDir: URL) -> Int {
        guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("runner.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int else { return defaultPort }
        return port
    }

    /// Whether `dataDir` is an installed runner's (Personal's or a
    /// profile's): one with a LaunchAgent the app may start, whose threads
    /// are real.
    public static func isInstalled(dataDir: URL, profiles: [ProfileEntry] = Profiles.all()) -> Bool {
        Profiles.entry(for: dataDir, in: profiles) != nil
    }

    /// The LaunchAgent label of the runner for `dataDir`.
    public static func launchdLabel(dataDir: URL, profiles: [ProfileEntry] = Profiles.all()) -> String {
        Profiles.entry(for: dataDir, in: profiles)?.label ?? launchdLabel
    }

    /// Where the looks every profile shares are kept (keyboard shortcuts):
    /// Personal's folder for any profile, a dev or mock folder its own.
    public static func sharedDir(dataDir: URL, profiles: [ProfileEntry] = Profiles.all()) -> URL {
        Profiles.entry(for: dataDir, in: profiles) != nil ? defaultDataDir : dataDir
    }
}
