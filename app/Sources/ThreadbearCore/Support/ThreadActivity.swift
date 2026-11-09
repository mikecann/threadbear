import Foundation

/// The Librarian page's Threadbear activity: a year of days shaded by how
/// many threads you started each day, as the profile page's card counts
/// them (runner/src/public-profile.ts, activityOf). Worked out on this Mac
/// from the threads the app already has, so nothing is fetched or sent.
/// It comes out as a GitHubContributions, so the same calendar draws both.
public enum ThreadActivity {
    /// One year of threads started, by this Mac's calendar day. Threads
    /// in a private folder aren't counted, as on the profile page.
    public static func year(_ year: Int, threads: [(createdAt: Date, cwd: String)], privateFolders: [String] = [],
                            calendar: Calendar = .current) -> GitHubContributions {
        var counts: [String: Int] = [:]
        for thread in threads where !isPrivate(thread.cwd, folders: privateFolders) {
            let c = calendar.dateComponents([.year, .month, .day], from: thread.createdAt)
            guard c.year == year, let month = c.month, let day = c.day else { continue }
            counts[String(format: "%04d-%02d-%02d", year, month, day), default: 0] += 1
        }
        let most = counts.values.max() ?? 0
        let days = counts.keys.sorted().map { key in
            GitHubContributions.Day(date: key, count: counts[key]!, level: level(counts[key]!, most: most))
        }
        return GitHubContributions(year: year, total: counts.values.reduce(0, +), days: days)
    }

    /// 0 for none, then 1 to 4 by quarters of the busiest day, so a quiet
    /// year still shades its busiest days darkest.
    public static func level(_ count: Int, most: Int) -> Int {
        guard count > 0, most > 0 else { return 0 }
        return min(4, max(1, Int((4 * Double(count) / Double(most)).rounded(.up))))
    }

    /// The first year with a thread, for how far back the arrows go.
    public static func firstYear(_ dates: [Date], calendar: Calendar = .current) -> Int? {
        dates.min().map { calendar.component(.year, from: $0) }
    }

    /// A folder in the list, or anywhere under one, with `~` for home, as
    /// the runner's own check (runner/src/models/index.ts, isPrivate).
    public static func isPrivate(_ cwd: String, folders: [String]) -> Bool {
        let at = standard(cwd)
        return folders.contains { folder in
            let p = standard(folder)
            guard !p.isEmpty else { return false }
            return at == p || at.hasPrefix(p.hasSuffix("/") ? p : p + "/")
        }
    }

    private static func standard(_ path: String) -> String {
        let expanded = (path as NSString).expandingTildeInPath
        let standard = (expanded as NSString).standardizingPath
        return standard.count > 1 && standard.hasSuffix("/") ? String(standard.dropLast()) : standard
    }
}
