import Foundation

/// Text as a shell or a plain text box should get it, from a copy out of
/// the transcript, a Markdown preview or a web page. Those draw with
/// characters a reader never sees: no-break spaces holding a button's
/// words together, zero-width spaces that let a long path wrap or give an
/// empty table cell its height, a thin space before a work link's ↑. A
/// shell takes each as a character of its own, so `ls` pasted with a
/// no-break space after it is a command called "ls " that isn't found,
/// and zsh shows a zero-width space as `<200b>`.
public enum PlainPaste {
    /// Spaces of every width as a plain space, the invisible ones gone.
    /// A zero-width joiner stays, as emoji like 👩‍💻 are built with it.
    public static func clean(_ text: String) -> String {
        guard text.unicodeScalars.contains(where: { odd.contains($0) || invisible.contains($0) }) else { return text }
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if invisible.contains(scalar) { continue }
            out.append(odd.contains(scalar) ? " " : scalar)
        }
        return String(out)
    }

    /// Spaces that look like a space but aren't one.
    static let odd: Set<Unicode.Scalar> = [
        "\u{00A0}", // no-break space
        "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}",
        "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}", // en, em, thin, hair...
        "\u{202F}", // narrow no-break space
        "\u{205F}", // medium mathematical space
        "\u{3000}", // ideographic space
    ]

    /// Characters with no width at all.
    static let invisible: Set<Unicode.Scalar> = [
        "\u{200B}", // zero-width space
        "\u{200C}", // zero-width non-joiner
        "\u{2060}", // word joiner
        "\u{FEFF}", // zero-width no-break space (byte order mark)
        "\u{00AD}", // soft hyphen
    ]
}
