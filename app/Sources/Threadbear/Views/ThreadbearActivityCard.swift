import SwiftUI
import ThreadbearCore

/// The Librarian page's Threadbear activity: a year of days shaded by how
/// many threads you started each day, the same card the profile page has.
/// Worked out from the threads the app already has (ThreadActivity), so
/// nothing is fetched; threads in a private folder aren't counted. Drawn
/// with the GitHub card's calendar, so the two sit together as a pair.
struct ThreadbearActivityCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.onPicture) private var onPicture
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var hovered: GitHubContributions.Day?
    @State private var gridWidth: CGFloat = 0

    private var thisYear: Int { Calendar.current.component(.year, from: Date()) }

    var body: some View {
        let threads = app.threads.values.map { (createdAt: $0.createdAt, cwd: $0.cwd) }
        let firstYear = min(thisYear, ThreadActivity.firstYear(threads.map(\.createdAt)) ?? thisYear)
        let activity = ThreadActivity.year(year, threads: threads, privateFolders: app.runnerSettings?.models.privateFolders ?? [])
        VStack(alignment: .leading, spacing: zoomed(12)) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top) {
                    heading(activity)
                    Spacer(minLength: zoomed(12))
                    yearStepper(firstYear: firstYear)
                }
                VStack(alignment: .leading, spacing: zoomed(8)) {
                    heading(activity)
                    yearStepper(firstYear: firstYear)
                }
            }
            let fits = gridWidth > 0 ? (gridWidth - ContributionGrid.labels) / CGFloat(max(1, activity.weeks().count)) : ContributionGrid.largest
            ScrollView(.horizontal, showsIndicators: false) {
                ContributionGrid(contributions: activity, pitch: min(ContributionGrid.largest, max(ContributionGrid.smallest, fits)),
                                 hovered: $hovered, open: { _ in }, unit: ("thread", "threads"))
            }
            .defaultScrollAnchor(.trailing)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { gridWidth = $0 }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: zoomed(6)) {
                    readoutText
                    Spacer(minLength: zoomed(12))
                    GitHubActivityCard.legend
                }
                VStack(alignment: .leading, spacing: zoomed(6)) {
                    GitHubActivityCard.legend
                    readoutText
                }
            }
        }
        .padding(zoomed(16))
        .frame(maxWidth: .infinity, alignment: .leading)
        .tileBackground(onPicture, radius: zoomed(12))
    }

    private func heading(_ activity: GitHubContributions) -> some View {
        VStack(alignment: .leading, spacing: zoomed(3)) {
            Text("Threadbear activity")
                .font(.system(size: zoomed(15), weight: .semibold))
                .lineLimit(1)
            Text("\(activity.total.formatted()) \(activity.total == 1 ? "thread" : "threads") started in \(String(year))")
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

    private var readout: String {
        guard let day = hovered else { return "Threads in a private folder aren't counted" }
        let when = GitHubActivityCard.dayTitle(day.date)
        switch day.count {
        case 0: return "No threads on \(when)"
        case 1: return "1 thread on \(when)"
        default: return "\(day.count) threads on \(when)"
        }
    }

    private func yearStepper(firstYear: Int) -> some View {
        HStack(spacing: zoomed(6)) {
            Button { year -= 1 } label: { Image(systemName: "chevron.left") }
                .disabled(year <= firstYear)
                .tip("The year before")
            Text(String(year))
                .font(.system(size: zoomed(15), weight: .medium))
                .monospacedDigit()
                .frame(minWidth: zoomed(44))
            Button { year += 1 } label: { Image(systemName: "chevron.right") }
                .disabled(year >= thisYear)
                .tip("The year after")
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }
}
