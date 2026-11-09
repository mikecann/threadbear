import AppKit
import SwiftUI
import ThreadbearCore

/// The Scheduled page: what clicking Scheduled in the activity bar shows
/// in the detail area, beside the sidebar's list. The bear winding its
/// alarm clock, a line on what schedules are, what's next and the numbers.
struct ScheduledHome: View {
    @Environment(AppModel.self) private var app
    /// Settings > General > Look. Off, the page is as it ships, whatever
    /// look is saved; the look is kept for when it's back on.
    @AppStorage(Looks.scheduledOnKey) private var customizable = false

    var body: some View {
        let stats = app.schedulesSupported ? ScheduledStats.tiles(app.schedules, now: app.now) : []
        if customizable {
            CustomizedScheduledPage(stats: stats)
        } else {
            HomePage(picture: Art.scheduled, pictureLabel: Self.pictureLabel, pokes: PokeLines.scheduled, stats: stats) {
                ScheduledAbout()
            }
        }
    }

    static let pictureLabel = "The bear winding a big alarm clock, beside a calendar"

    static let more = "Once at a set time, or over and over, like every weekday at 9. Each goes to a thread, or starts a new thread each time. Agents book them too, to check back on something. Make one with New schedule in the list, from Schedule… in a composer, or by asking an agent. A schedule that sends to a thread puts it under Waiting until then. A schedule that starts a new thread can run on another of your Macs (Runs on). Schedules live in your Convex backend, so with no internet they wait."
}

/// The Scheduled page laid out as the user set it (ScheduledLook): the
/// bear, their own picture or none, a background photo, and the picture,
/// title and numbers each at the top, middle or bottom, or hidden.
private struct CustomizedScheduledPage: View {
    @AppStorage(Looks.scheduledKey) private var saved = Data()
    let stats: [HomeStat]

    var body: some View {
        // `saved` redraws the page as the panel changes the look.
        let look = ScheduledLook.load(saved)
        CustomizedPage(backdrop: Looks.image(look.background), dim: look.backgroundDim, focus: look.backgroundFocus, slot: .scheduled,
                       filled: Set(look.layout.map(look.place)), pinsPlaces: true,
                       customizeTip: "Change the picture, the background, and where each part of this page sits") { place in
            ForEach(look.layout.filter { look.place($0) == place }) { block in
                part(block, look: look)
            }
        } buttons: {
            EmptyView()
        } editor: { done in
            ScheduledLookEditor(look: Looks.scheduledBinding(), done: done)
        }
    }

    @ViewBuilder
    private func part(_ block: ScheduledLook.Block, look: ScheduledLook) -> some View {
        switch block {
        case .picture:
            if let image = look.picture == .own ? Looks.image(look.pictureFile) : Art.scheduled {
                // Room under it for what the bear says when it's poked.
                PokeablePicture(picture: image,
                                label: look.picture == .own ? "Your picture" : ScheduledHome.pictureLabel,
                                lines: look.picture == .bear ? PokeLines.scheduled : [],
                                side: look.pictureSize.side)
                    .padding(.bottom, look.picture == .bear ? zoomed(4) : 0)
            }
        case .about:
            ScheduledAbout()
                .frame(maxWidth: zoomed(620), alignment: .leading)
        case .numbers:
            LookNumbers(stats: stats, hidden: look.hiddenNumbers)
        }
    }
}

/// The title, a line on what schedules are (more behind the ⓘ), and
/// what's next.
private struct ScheduledAbout: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            HomeTitle(title: "Scheduled",
                      line: "Messages that send themselves later, once or on repeat.",
                      more: ScheduledHome.more)
            let next = ScheduledStats.next(app.schedules)
            HomeStatusLine(text: next.map { "Next: \(ScheduledStats.title($0)), \(ScheduledStats.when($0, now: app.now))" } ?? "Nothing coming up",
                           busy: next != nil)
        }
    }
}

/// The page's numbers, from the schedules the app already has.
enum ScheduledStats {
    /// Every number, by its key, for the Customize panel's switches: there
    /// even while the runner's away and the tiles aren't.
    static let names: [(key: String, title: String)] = [
        ("on", "On"), ("dueSoon", "Due in a day"), ("repeating", "Repeating"),
        ("byThreads", "Set by threads"), ("paused", "Paused"), ("runs", "Runs so far"),
    ]

    /// The active schedule due soonest.
    static func next(_ schedules: [Schedule]) -> Schedule? {
        schedules.filter(\.isActive).compactMap { s in s.nextRunAt.map { (s, $0) } }.min { $0.1 < $1.1 }?.0
    }

    static func title(_ schedule: Schedule) -> String {
        schedule.title.isEmpty ? "Untitled" : schedule.title
    }

    /// "in 12 min", "at 14:00", "Fri 9:00".
    static func when(_ schedule: Schedule, now: Date) -> String {
        guard let at = schedule.nextRunAt else { return schedule.whenText }
        let seconds = at.timeIntervalSince(now)
        if seconds < 60 { return "any moment" }
        if seconds < 3600 { return "in \(Int(seconds / 60)) min" }
        let calendar = Calendar.current
        return calendar.isDate(at, inSameDayAs: now) ? "at " + RelativeTime.until(at, now: now) : RelativeTime.until(at, now: now)
    }

    static func tiles(_ schedules: [Schedule], now: Date) -> [HomeStat] {
        let active = schedules.filter(\.isActive)
        let dayAhead = active.filter { ($0.nextRunAt ?? .distantFuture) <= now.addingTimeInterval(86_400) }.count
        let repeating = active.filter { !$0.isOneOff }.count
        let byAgents = active.filter { $0.createdBy != nil }.count
        let paused = schedules.filter { $0.paused && !$0.isFinished }.count
        let runs = schedules.reduce(0) { $0.adding(saturating: $1.runs) }
        return [
            HomeStat(value: "\(active.count)", label: "On",
                     help: "Schedules that will still run: not paused and not finished", key: "on"),
            HomeStat(value: "\(dayAhead)", label: "Due in a day",
                     help: "On schedules due to run in the next 24 hours", key: "dueSoon"),
            HomeStat(value: "\(repeating)", label: "Repeating",
                     help: "On schedules that run over and over, rather than once", key: "repeating"),
            HomeStat(value: "\(byAgents)", label: byAgents == 1 ? "Set by a thread" : "Set by threads",
                     help: "On schedules an agent booked, usually to check back on its own thread", key: "byThreads"),
            HomeStat(value: "\(paused)", label: "Paused",
                     help: "Schedules waiting for you to resume them", key: "paused"),
            HomeStat(value: "\(runs)", label: runs == 1 ? "Run so far" : "Runs so far",
                     help: "Times the schedules in the list have sent their message", key: "runs"),
        ]
    }
}
