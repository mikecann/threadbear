import Foundation

/// What a stretch of speech puts into a note (NoteDictation): the words,
/// spaced from what's either side of the cursor, so talking after a word
/// doesn't run into it. "New line" or "new paragraph" said on its own is a
/// line break, as macOS's own dictation has it.
public enum DictatedText {
    /// The text to insert for `words`, between `before` and `after` (the
    /// characters either side of the cursor, nil at the ends of the note).
    /// Nil for nothing to insert.
    public static func insertion(_ words: String, before: Character?, after: Character?) -> String? {
        let spoken = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return nil }
        if let breakText = lineBreak(spoken) { return breakText }
        var text = spoken
        // After a line break or at the start, a new line starts with a capital.
        if before == nil || before?.isNewline == true, let first = text.first, first.isLowercase {
            text = first.uppercased() + text.dropFirst()
        }
        if let before, !before.isWhitespace { text = " " + text }
        if let after, !after.isWhitespace, !closing.contains(after) { text += " " }
        return text
    }

    /// Characters the next words can sit right against.
    private static let closing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "}", "\"", "'"]

    private static func lineBreak(_ spoken: String) -> String? {
        let bare = spoken.lowercased().trimmingCharacters(in: .punctuationCharacters.union(.whitespaces))
        switch bare {
        case "new line", "newline", "next line": return "\n"
        case "new paragraph", "next paragraph": return "\n\n"
        default: return nil
        }
    }
}
