import Foundation

/// A Plan first plan on the phone (backend API 72): its title, the card it
/// waits on, and the file it's shared as.
public enum Plans {
    /// The tool Claude puts its plan to Mike with. Its approval is the plan's
    /// Go ahead (allow) and Send back (deny).
    public static let toolName = "ExitPlanMode"

    /// Whether a thread's open card is a plan waiting for Go ahead.
    public static func waiting(_ pending: PendingApproval?) -> Bool {
        if case let .approval(_, name, _, _, _) = pending { return name == toolName }
        return false
    }

    /// Whether that card's Go ahead can be given from the phone: the runner
    /// offers only Deny there when the line it shows isn't all of it.
    public static func canGoAhead(_ pending: PendingApproval?) -> Bool {
        if waiting(pending), case let .approval(_, _, _, options, _) = pending { return options.contains(.allow) }
        return false
    }

    /// The newest plan in a thread's messages.
    public static func latest(in messages: [PhoneMessage]) -> PhoneMessage? {
        messages.last { $0.plan }
    }

    /// The plan's first heading, else its first line, without Markdown marks.
    public static func title(of text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map { $0.trimmingCharacters(in: .whitespaces) }
        let line = lines.first { $0.hasPrefix("#") } ?? lines.first { !$0.isEmpty } ?? ""
        let bare = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
        return bare.isEmpty ? "Plan" : String(bare.prefix(120))
    }

    /// The plan without its title line, for the card's few lines under it.
    public static func body(of text: String) -> String {
        var lines = text.components(separatedBy: "\n")
        if let first = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
           lines[first].trimmingCharacters(in: .whitespaces).hasPrefix("#") {
            lines.removeSubrange(...first)
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A file name for sharing: the title in lowercase words, `plan.md` if
    /// there are none.
    public static func fileName(for text: String) -> String {
        let words = title(of: text).lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        let slug = words.prefix(8).joined(separator: "-")
        return (slug.isEmpty ? "plan" : slug) + ".md"
    }
}
