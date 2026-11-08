import AppKit
import SwiftUI
import ThreadbearCore

/// Someone's public GitHub contributions for a year, as on their GitHub
/// profile: a square a day, darker for more, with the year's total and
/// arrows to step through years. Hovering a day says its count; clicking
/// one opens that day on their profile. Grey in both appearances, like the
/// rest of the page, so it sits beside the numbers rather than shouting.
struct GitHubActivityCard: View {
    @Environment(\.onPicture) private var onPicture
    let user: String
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var hovered: GitHubContributions.Day?
    @State private var gridWidth: CGFloat = 0

    private var activity: GitHubActivity { .shared }
    private var name: String { GitHubUser.clean(user) }
    private var thisYear: Int { Calendar.current.component(.year, from: Date()) }

    var body: some View {
        let state = activity.state(user: name, year: year)
        VStack(alignment: .leading, spacing: zoomed(12)) {
            // Side by side when there's room, the years under the title
            // when the page is narrow.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top) {
                    heading(state)
                    Spacer(minLength: zoomed(12))
                    yearStepper
                }
                VStack(alignment: .leading, spacing: zoomed(8)) {
                    heading(state)
                    yearStepper
                }
            }
            calendar(state)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: zoomed(6)) {
                    readoutText
                    Spacer(minLength: zoomed(12))
                    legend
                }
                VStack(alignment: .leading, spacing: zoomed(6)) {
                    legend
                    readoutText
                }
            }
        }
        .padding(zoomed(16))
        .frame(maxWidth: .infinity, alignment: .leading)
        .tileBackground(onPicture, radius: zoomed(12))
        .task(id: "\(name)/\(year)") { activity.load(user: name, year: year) }
    }

    private func heading(_ state: GitHubActivity.State?) -> some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            Text("GitHub activity")
                .font(.system(size: zoomed(15), weight: .semibold))
                .lineLimit(1)
            Text(subtitle(state))
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var readoutText: some View {
        Text(readout)
            .font(.system(size: TypeScale.label))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var legend: some View {
        HStack(spacing: zoomed(4)) {
            Text("Less")
            ForEach(0..<5, id: \.self) { level in
                RoundedRectangle(cornerRadius: zoomed(2), style: .continuous)
                    .fill(Self.shade(level))
                    .frame(width: zoomed(10), height: zoomed(10))
            }
            Text("More")
        }
        .font(.system(size: zoomed(11)))
        .foregroundStyle(.secondary)
        .fixedSize()
    }

    private func subtitle(_ state: GitHubActivity.State?) -> String {
        switch state {
        case .loaded(let contributions):
            let count = contributions.total.formatted()
            return "\(count) \(contributions.total == 1 ? "contribution" : "contributions") in \(String(year))"
        case .failed(let message): return message
        case .loading, nil: return "Loading @\(name)'s \(String(year))…"
        }
    }

    private var readout: String {
        guard let day = hovered else { return "@\(name)'s public contributions" }
        let when = Self.dayTitle(day.date)
        switch day.count {
        case 0: return "No contributions on \(when)"
        case 1: return "1 contribution on \(when)"
        default: return "\(day.count) contributions on \(when)"
        }
    }

    private var yearStepper: some View {
        HStack(spacing: zoomed(6)) {
            Button { year -= 1 } label: { Image(systemName: "chevron.left") }
                .disabled(year <= 2008)
                .tip("The year before")
            Text(String(year))
                .font(.system(size: zoomed(15), weight: .medium))
                .monospacedDigit()
                .frame(minWidth: zoomed(44))
            Button { year += 1 } label: { Image(systemName: "chevron.right") }
                .disabled(year >= thisYear)
                .tip("The year after")
            Button { activity.load(user: name, year: year, force: true) } label: { Image(systemName: "arrow.clockwise") }
                .disabled(activity.state(user: name, year: year) == .loading)
                .tip("Fetch this year from GitHub again")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }

    @ViewBuilder
    private func calendar(_ state: GitHubActivity.State?) -> some View {
        switch state {
        case .loaded(let contributions):
            // The squares shrink to fit the card, down to a size still
            // easy to hover; past that it scrolls, starting at the latest
            // weeks.
            let fits = gridWidth > 0 ? (gridWidth - ContributionGrid.labels) / CGFloat(max(1, contributions.weeks().count)) : ContributionGrid.largest
            ScrollView(.horizontal, showsIndicators: false) {
                ContributionGrid(contributions: contributions, pitch: min(ContributionGrid.largest, max(ContributionGrid.smallest, fits)), hovered: $hovered) { day in
                    if let url = URL(string: "https://github.com/\(name)?tab=overview&from=\(day.date)&to=\(day.date)") {
                        _ = OpenGate.openWeb(url)
                    }
                }
            }
            .defaultScrollAnchor(.trailing)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { gridWidth = $0 }
        case .failed:
            Button("Try again") { activity.load(user: name, year: year, force: true) }
                .controlSize(.small)
                .tip("Fetch this year from GitHub again")
                .frame(height: ContributionGrid.height, alignment: .center)
        case .loading, nil:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity)
                .frame(height: ContributionGrid.height)
        }
    }

    /// Grey from faint to full, the page's own ink in light and dark.
    static func shade(_ level: Int) -> Color {
        let opacity: [Double] = [0.07, 0.22, 0.42, 0.66, 0.92]
        return Color.primary.opacity(opacity[min(4, max(0, level))])
    }

    static func dayTitle(_ date: String) -> String {
        let parse = DateFormatter()
        parse.calendar = GitHubContributions.gregorian
        parse.timeZone = GitHubContributions.gregorian.timeZone
        parse.locale = Locale(identifier: "en_US_POSIX")
        parse.dateFormat = "yyyy-MM-dd"
        guard let day = parse.date(from: date) else { return date }
        let show = DateFormatter()
        show.timeZone = GitHubContributions.gregorian.timeZone
        show.setLocalizedDateFormatFromTemplate("EEE MMM d")
        return show.string(from: day)
    }
}

/// The squares, drawn in one Canvas (a year is 371 cells), with month
/// names above and Mon, Wed, Fri beside, as GitHub has them.
struct ContributionGrid: View {
    let contributions: GitHubContributions
    let pitch: CGFloat
    @Binding var hovered: GitHubContributions.Day?
    let open: (GitHubContributions.Day) -> Void

    static var largest: CGFloat { zoomed(13) }
    static var smallest: CGFloat { zoomed(8) }
    static var labels: CGFloat { zoomed(30) }
    static var months: CGFloat { zoomed(18) }
    static var height: CGFloat { months + 7 * largest }
    private var gap: CGFloat { max(1.5, pitch * 0.2) }

    var body: some View {
        let weeks = contributions.weeks()
        let starts = contributions.monthStarts()
        let width = Self.labels + CGFloat(weeks.count) * pitch
        let pitch = self.pitch
        let side = pitch - gap
        Canvas { context, _ in
            for (row, name) in [(1, "Mon"), (3, "Wed"), (5, "Fri")] {
                context.draw(Text(name).font(.system(size: zoomed(10))).foregroundStyle(.secondary),
                             at: CGPoint(x: 0, y: Self.months + CGFloat(row) * pitch + side / 2), anchor: .leading)
            }
            for start in starts {
                context.draw(Text(start.month).font(.system(size: zoomed(10))).foregroundStyle(.secondary),
                             at: CGPoint(x: Self.labels + CGFloat(start.week) * pitch, y: 0), anchor: .topLeading)
            }
            for (column, week) in weeks.enumerated() {
                for (row, day) in week.enumerated() {
                    guard let day else { continue }
                    let rect = CGRect(x: Self.labels + CGFloat(column) * pitch, y: Self.months + CGFloat(row) * pitch, width: side, height: side)
                    let path = Path(roundedRect: rect, cornerRadius: zoomed(2), style: .continuous)
                    context.fill(path, with: .color(GitHubActivityCard.shade(day.level)))
                    if day == hovered {
                        context.stroke(path, with: .color(.primary.opacity(0.9)), lineWidth: 1)
                    }
                }
            }
        }
        .frame(width: width, height: Self.months + 7 * pitch)
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): hovered = day(at: point, weeks: weeks)
            case .ended: hovered = nil
            }
        }
        .onTapGesture { point in
            if let day = day(at: point, weeks: weeks) { open(day) }
        }
        .accessibilityElement()
        .accessibilityLabel("\(contributions.total) contributions in \(String(contributions.year))")
    }

    private func day(at point: CGPoint, weeks: [[GitHubContributions.Day?]]) -> GitHubContributions.Day? {
        let column = Int((point.x - Self.labels) / pitch)
        let row = Int((point.y - Self.months) / pitch)
        guard point.x >= Self.labels, point.y >= Self.months, weeks.indices.contains(column), (0..<7).contains(row) else { return nil }
        return weeks[column][row]
    }
}
