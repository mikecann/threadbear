import Foundation

/// Searching the text inside a folder's files, for the Files panel's
/// search field: every line that has the words, with its file and line
/// number, so a click opens the file there. Folders nobody means to
/// search (`.git`, `node_modules`, build output) are skipped, and so are
/// big files and anything that isn't text. Runs off the main thread; the
/// caller stops it by returning true from `stop`.
public enum FolderSearch {
    public struct Hit: Equatable, Sendable, Identifiable {
        /// The file's full path.
        public var path: String
        /// From 1, as editors count them.
        public var line: Int
        /// The line, trimmed and cut short around the match.
        public var text: String
        public var id: String { "\(path):\(line)" }

        public init(path: String, line: Int, text: String) {
            self.path = path
            self.line = line
            self.text = text
        }
    }

    public struct Result: Equatable, Sendable {
        public var hits: [Hit]
        /// More matched than `limit`: the list stops there.
        public var cut: Bool
        /// Files whose text was read.
        public var searched: Int

        public init(hits: [Hit] = [], cut: Bool = false, searched: Int = 0) {
            self.hits = hits
            self.cut = cut
            self.searched = searched
        }
    }

    /// Folders skipped wherever they are: version control, dependencies,
    /// build output and caches.
    public static let skippedFolders: Set<String> = [
        ".git", ".hg", ".svn", "node_modules", ".build", "build", "dist", "out", ".next", ".nuxt",
        ".turbo", ".cache", ".parcel-cache", "DerivedData", "Pods", ".venv", "venv", "__pycache__",
        "target", ".gradle", ".idea", "coverage", ".expo", ".svelte-kit", ".vercel", ".convex",
    ]

    /// Bigger files aren't read: they're data or generated, and slow.
    public static let maxFileSize = 1_000_000
    public static let defaultLimit = 500
    /// The line shown for a hit is cut to about this many characters.
    public static let shownLength = 160

    public static func skips(folder name: String) -> Bool {
        skippedFolders.contains(name)
    }

    /// The lines of `text` with `query` in them, without case, as
    /// (line number from 1, the line as shown).
    public static func matches(in text: String, query: String, limit: Int = .max) -> [(line: Int, text: String)] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, limit > 0 else { return [] }
        var found: [(line: Int, text: String)] = []
        var number = 0
        text.enumerateLines { line, stop in
            number += 1
            if let range = line.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) {
                found.append((number, shown(line, around: range)))
                if found.count >= limit { stop = true }
            }
        }
        return found
    }

    /// A line for the results list: leading space gone, and a long one cut
    /// to a window around the match with … at the cut ends.
    public static func shown(_ line: String, around range: Range<String.Index>) -> String {
        let leading = line.prefix(while: { $0 == " " || $0 == "\t" }).count
        let start = line.index(line.startIndex, offsetBy: leading)
        guard start <= range.lowerBound else { return String(line.prefix(shownLength)) }
        let trimmed = line[start...]
        guard trimmed.count > shownLength else { return String(trimmed).trimmingCharacters(in: .whitespaces) }
        let before = trimmed.distance(from: trimmed.startIndex, to: range.lowerBound)
        let from = max(0, before - 40)
        let lower = trimmed.index(trimmed.startIndex, offsetBy: from)
        let upper = trimmed.index(lower, offsetBy: min(shownLength, trimmed.distance(from: lower, to: trimmed.endIndex)))
        return (from > 0 ? "…" : "") + trimmed[lower..<upper] + (upper < trimmed.endIndex ? "…" : "")
    }

    /// Searches every text file under `root`. Hidden files and folders are
    /// searched (a `.env.example`, `.github`), except the skipped ones.
    public static func search(root: String, query: String, limit: Int = defaultLimit, stop: () -> Bool = { false }) -> Result {
        var result = Result()
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return result }
        let rootURL = URL(fileURLWithPath: root, isDirectory: true)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isRegularFileKey, .fileSizeKey, .isSymbolicLinkKey, .isPackageKey]
        guard let walk = FileManager.default.enumerator(at: rootURL, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true }) else {
            return result
        }
        // The walk gives paths through symlinks resolved (/private/var for
        // /var); hits are named under the root as it was given.
        // (realpath: URL's own resolving takes /private off again.)
        let resolved = realpath(root, nil).map { defer { free($0) }; return String(cString: $0) } ?? root
        func asGiven(_ path: String) -> String {
            guard resolved != root, path.hasPrefix(resolved + "/") else { return path }
            return (root.hasSuffix("/") ? String(root.dropLast()) : root) + path.dropFirst(resolved.count)
        }
        var files: [URL] = []
        for case let url as URL in walk {
            if stop() { return result }
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { continue }
            if values.isDirectory == true {
                if skips(folder: url.lastPathComponent) || values.isPackage == true { walk.skipDescendants() }
                continue
            }
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  (values.fileSize ?? 0) <= maxFileSize, (values.fileSize ?? 0) > 0 else { continue }
            files.append(url)
        }
        // In path order, so the list reads folder by folder.
        files.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        for url in files {
            if stop() { return result }
            guard let data = try? Data(contentsOf: url), PreviewRules.looksLikeText(data.prefix(8192)),
                  let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { continue }
            result.searched += 1
            let room = limit - result.hits.count
            for match in matches(in: text, query: query, limit: room + 1) {
                if result.hits.count >= limit { result.cut = true; return result }
                result.hits.append(Hit(path: asGiven(url.path), line: match.line, text: match.text))
            }
        }
        return result
    }

    /// The path under `root`, for the results list: `src/app.ts`.
    public static func relative(_ path: String, to root: String) -> String {
        let base = root.hasSuffix("/") ? root : root + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : path
    }
}
