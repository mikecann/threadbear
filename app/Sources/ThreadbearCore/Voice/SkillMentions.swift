import Foundation
import os

/// The installed skills' slash commands (/pele) found in text, so the
/// composer and the transcript can show them like links: what you typed
/// will run that skill. Only skills Threadbear has count, and only as a
/// word of their own ("/pele", "run /pele now"), never inside a path
/// ("src/pele.ts") or a longer word ("/peler").
public enum SkillMentions {
    /// A skill the composer's / list offers.
    public struct Entry: Sendable, Hashable {
        public var name: String
        public var description: String
        public init(name: String, description: String) {
            self.name = name
            self.description = description
        }
    }

    private static let state = OSAllocatedUnfairLock<Set<String>>(initialState: [])
    private static let entries = OSAllocatedUnfairLock<[Entry]>(initialState: [])

    /// The skills with their descriptions, for the composer's / list. Setting
    /// them sets `names` too.
    public static var skills: [Entry] {
        get { entries.withLock { $0 } }
        set {
            entries.withLock { $0 = newValue }
            names = Set(newValue.map(\.name))
        }
    }

    /// The skills' names, set by the app when its list changes. Read from
    /// any thread (the transcript renders off the main one).
    public static var names: Set<String> {
        get { state.withLock { $0 } }
        set { state.withLock { $0 = newValue } }
    }

    /// Each mention's range (the slash and the name) in `text`.
    public static func ranges(in text: String, names: Set<String>? = nil) -> [NSRange] {
        let known = names ?? self.names
        guard !known.isEmpty, text.contains("/") else { return [] }
        let ns = text as NSString
        var out: [NSRange] = []
        // A slash at the start or after a space or bracket, then the name.
        let regex = try! NSRegularExpression(pattern: #"(?<![\w/.~:-])/([a-z0-9][a-z0-9-]*)(?![\w/-])"#, options: [.caseInsensitive])
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1)).lowercased()
            if known.contains(name) { out.append(match.range) }
        }
        return out
    }

    /// The link a mention carries; a click on it opens the Skills page.
    public static func url(for name: String) -> URL? { URL(string: "threadbear-skill:\(name)") }

    /// The skill a mention's link names, or nil for any other link.
    public static func name(of url: URL) -> String? {
        url.scheme == "threadbear-skill" ? url.absoluteString.replacingOccurrences(of: "threadbear-skill:", with: "") : nil
    }
}
