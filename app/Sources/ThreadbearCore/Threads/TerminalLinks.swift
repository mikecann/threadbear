import Foundation

/// Web addresses in a terminal's text, for ⌘-click in the Terminal panel:
/// a dev server's `http://localhost:5173/`, a deploy's https link. Only
/// http and https come out of here (LinkPolicy.web), so text a program
/// prints can't start another app through a `file:` or custom-scheme link.
/// A bare `localhost:5173` or `127.0.0.1:8080` counts as http, as dev
/// servers often print it that way.
public enum TerminalLinks {
    /// The web address under `column` in a line of the terminal (one
    /// Character per cell), or nil when there isn't one there.
    public static func link(in line: String, at column: Int) -> URL? {
        span(in: line, at: column)?.url
    }

    /// The web address under `column` and the cells it covers, for
    /// underlining it while the pointer is over it.
    public static func span(in line: String, at column: Int) -> (columns: Range<Int>, url: URL)? {
        let chars = Array(line)
        guard column >= 0, column < chars.count, !stops(chars[column]) else { return nil }
        var start = column
        while start > 0, !stops(chars[start - 1]) { start -= 1 }
        var end = column
        while end + 1 < chars.count, !stops(chars[end + 1]) { end += 1 }
        let word = String(chars[start...end])
        // The word may carry text in front, like `Local:http://…` or `(https://…`.
        for found in candidates(in: word) {
            let lower = word.distance(from: word.startIndex, to: found.lowerBound) + start
            let upper = word.distance(from: word.startIndex, to: found.upperBound) + start
            guard column >= lower, column < upper else { continue }
            if let url = url(from: String(word[found])) { return (lower..<upper, url) }
        }
        return nil
    }

    /// Every web address in a piece of text, in order.
    public static func links(in text: String) -> [URL] {
        text.split(whereSeparator: stops).flatMap { word -> [URL] in
            let word = String(word)
            return candidates(in: word).compactMap { url(from: String(word[$0])) }
        }
    }

    private static func stops(_ c: Character) -> Bool {
        c.isWhitespace || c == "\0" || c == "\"" || c == "'" || c == "<" || c == ">" || c == "`"
            || c == "│" || c == "┃"
    }

    private static var pattern: Regex<(Substring, Substring)> { /(?i)(https?:\/\/[^\s]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?:\/[^\s]*)?)/ }

    private static func candidates(in word: String) -> [Range<String.Index>] {
        word.matches(of: pattern).map { trimmed(word, $0.range) }
    }

    /// Punctuation a sentence puts after a link, not part of it: `.` `,`
    /// `:` `;` `!` `?`, and a closing bracket with no opening one inside.
    private static func trimmed(_ word: String, _ range: Range<String.Index>) -> Range<String.Index> {
        var end = range.upperBound
        while end > range.lowerBound {
            let last = word[word.index(before: end)]
            let inside = word[range.lowerBound..<word.index(before: end)]
            let unopened = (last == ")" && !inside.contains("("))
                || (last == "]" && !inside.contains("["))
                || (last == "}" && !inside.contains("{"))
            guard ".,:;!?".contains(last) || unopened else { break }
            end = word.index(before: end)
        }
        return range.lowerBound..<end
    }

    private static func url(from text: String) -> URL? {
        guard text.count <= 4_096 else { return nil }
        let lower = text.lowercased()
        let full = lower.hasPrefix("http://") || lower.hasPrefix("https://") ? text : "http://" + text
        guard let url = URL(string: full) ?? URL(string: full.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "") else { return nil }
        return LinkPolicy.web(url)
    }
}
