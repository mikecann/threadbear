import Foundation

/// Mike's own messages drawn with basic Markdown (lists, bold, italics,
/// code, links, headings, quotes), as the agent's replies are. Two things
/// differ from a reply: a message with nothing Markdown in it stays plain
/// text, exactly as it was, and every line break he typed is kept (in
/// Markdown a single newline joins the lines), except inside code blocks.
public enum UserMarkdown {
    /// The text to give the Markdown renderer, or nil to show it as plain.
    public static func prepare(_ text: String) -> String? {
        guard looksLikeMarkdown(text) else { return nil }
        var out: [String] = []
        var inCode = false
        var inList = false
        let lines = text.components(separatedBy: "\n")
        for (i, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inCode.toggle()
                out.append(line)
                continue
            }
            if !inCode {
                let item = trimmed.range(of: #"^([-*+]|\d{1,9}[.)])\s"#, options: .regularExpression) != nil
                // A line straight after a list, not indented under it, ends
                // the list (as in a chat), rather than joining its last item.
                if inList, !item, !trimmed.isEmpty, !line.hasPrefix(" "), !line.hasPrefix("\t") { out.append("") }
                inList = item || (inList && (line.hasPrefix(" ") || line.hasPrefix("\t")))
                if trimmed.isEmpty { inList = false }
            }
            let next = i + 1 < lines.count ? lines[i + 1].trimmingCharacters(in: .whitespaces) : ""
            // A hard break (two spaces) keeps his line break, unless the
            // line ends a paragraph anyway or the next starts a block.
            if !inCode, !trimmed.isEmpty, !next.isEmpty, !startsBlock(next) {
                out.append(line + "  ")
            } else {
                out.append(line)
            }
        }
        return out.joined(separator: "\n")
    }

    /// Lists, emphasis, code, links, headings or quotes anywhere in it.
    static func looksLikeMarkdown(_ text: String) -> Bool {
        for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.range(of: #"^([-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>\s?|```|~~~)"#, options: .regularExpression) != nil { return true }
        }
        return text.range(of: #"(\*\*[^*\n]+\*\*|__[^_\n]+__|(^|[\s(])\*[^*\s][^*\n]*\*|(^|[\s(])_[^_\s][^_\n]*_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|~~[^~\n]+~~)"#, options: .regularExpression) != nil
    }

    /// A line that starts a block of its own (so the line before needs no
    /// hard break to end there).
    static func startsBlock(_ line: String) -> Bool {
        line.range(of: #"^([-*+]\s|\d{1,9}[.)]\s|#{1,6}\s|>|```|~~~)"#, options: .regularExpression) != nil
    }
}
