import CryptoKit
import Foundation

/// One of Mike's notes (the bar's Notes page). Kept on this Mac only,
/// each sealed with AES-GCM under a key in the Keychain (NotesStore), so a
/// note never goes to the runner, an agent or the backend, and what's on
/// disk can't be read without the Mac's login.
public struct Note: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var body: String
    public var createdAt: Date
    public var updatedAt: Date

    public init(id: String = UUID().uuidString, title: String, body: String = "", createdAt: Date = Date(), updatedAt: Date = Date()) {
        self.id = id
        self.title = title
        self.body = body
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum NoteCrypto {
    public enum Failure: Error { case badData }

    /// The note as stored: a version byte, then AES-GCM's nonce, text and tag.
    public static func seal(_ note: Note, key: SymmetricKey) throws -> Data {
        // Dates as exact seconds (ISO 8601 would drop the fractions).
        let box = try AES.GCM.seal(try JSONEncoder().encode(note), using: key)
        guard let combined = box.combined else { throw Failure.badData }
        return Data([1]) + combined
    }

    public static func open(_ data: Data, key: SymmetricKey) throws -> Note {
        guard data.first == 1 else { throw Failure.badData }
        let box = try AES.GCM.SealedBox(combined: data.dropFirst())
        return try JSONDecoder().decode(Note.self, from: try AES.GCM.open(box, using: key))
    }
}

public enum NoteNames {
    public static let base = "Untitled note"

    /// "Untitled note", or the first "Untitled note N" not taken.
    public static func next(after titles: [String]) -> String {
        let taken = Set(titles.map { $0.trimmingCharacters(in: .whitespaces).lowercased() })
        if !taken.contains(base.lowercased()) { return base }
        var n = 2
        while taken.contains("\(base) \(n)".lowercased()) { n += 1 }
        return "\(base) \(n)"
    }

    /// A title as kept: trimmed, one line, never empty.
    public static func clean(_ title: String, fallback: String) -> String {
        let one = title.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return one.isEmpty ? fallback : String(one.prefix(200))
    }
}

/// What the notes editor colours: basic Markdown, line by line, as an
/// editor shows it (the marks stay, dimmed; the words get the style).
public enum NoteHighlight {
    public enum Kind: Sendable, Equatable {
        case heading, bold, italic, code, codeBlock, listMarker, link, quote, mark
    }

    public struct Span: Sendable, Equatable {
        public var range: NSRange
        public var kind: Kind
        public init(_ range: NSRange, _ kind: Kind) {
            self.range = range
            self.kind = kind
        }
    }

    private static let rules: [(NSRegularExpression, Kind, Int)] = [
        (try! NSRegularExpression(pattern: #"\*\*[^*\n]+\*\*|__[^_\n]+__"#), .bold, 0),
        (try! NSRegularExpression(pattern: #"(?<![*\w])\*[^*\s][^*\n]*\*(?!\*)|(?<![_\w])_[^_\s][^_\n]*_(?!\w)"#), .italic, 0),
        (try! NSRegularExpression(pattern: #"`[^`\n]+`"#), .code, 0),
        (try! NSRegularExpression(pattern: #"\[[^\]\n]+\]\([^)\s]+\)|https?://[^\s)]+"#), .link, 0),
    ]

    public static func spans(in text: String) -> [Span] {
        let ns = text as NSString
        var out: [Span] = []
        var inFence = false
        var location = 0
        for line in text.components(separatedBy: "\n") {
            let length = (line as NSString).length
            let range = NSRange(location: location, length: length)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                out.append(Span(range, .codeBlock))
                inFence.toggle()
            } else if inFence {
                out.append(Span(range, .codeBlock))
            } else if let m = try! NSRegularExpression(pattern: #"^(#{1,6})\s"#).firstMatch(in: line, range: NSRange(location: 0, length: length)) {
                out.append(Span(range, .heading))
                out.append(Span(NSRange(location: location, length: m.range(at: 1).length), .mark))
            } else if let m = try! NSRegularExpression(pattern: #"^\s*>\s?"#).firstMatch(in: line, range: NSRange(location: 0, length: length)) {
                out.append(Span(range, .quote))
                out.append(Span(NSRange(location: location + m.range.location, length: m.range.length), .mark))
            } else {
                if let m = try! NSRegularExpression(pattern: #"^\s*([-*+]|\d{1,9}[.)])\s(\[[ xX]\]\s)?"#).firstMatch(in: line, range: NSRange(location: 0, length: length)) {
                    out.append(Span(NSRange(location: location + m.range.location, length: m.range.length), .listMarker))
                }
                for (regex, kind, _) in rules {
                    for m in regex.matches(in: line, range: NSRange(location: 0, length: length)) {
                        out.append(Span(NSRange(location: location + m.range.location, length: m.range.length), kind))
                    }
                }
            }
            location += length + 1
        }
        _ = ns
        return out
    }
}
