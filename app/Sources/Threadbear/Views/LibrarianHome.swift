import AppKit
import SwiftUI
import ThreadbearCore

/// The Librarian's page: what clicking Librarian in the activity bar shows
/// in the detail area, beside the sidebar's queue and recent looks. The
/// bear at its card catalogue, a line on what the librarian is for, what
/// it's doing now and its numbers.
struct LibrarianHome: View {
    @Environment(AppModel.self) private var app
    /// Settings > General > Look. Off, the page is as it ships, whatever
    /// look is saved; the look is kept for when it's back on.
    @AppStorage(Looks.librarianOnKey) private var customizable = false

    var body: some View {
        let stats = app.librarian.map { LibrarianStats.tiles($0, projects: app.projects, threads: Array(app.threads.values)) } ?? []
        if customizable {
            CustomizedLibrarianPage(stats: stats)
        } else {
            HomePage(picture: Art.librarian, pictureLabel: "The librarian bear, filing a card in a card catalogue", pokes: PokeLines.librarian,
                     stats: stats) {
                LibrarianAbout(status: app.librarian)
            } below: {
                if let status = app.librarian {
                    LibrarianSettings(status: status)
                }
            }
        }
    }
}

/// The Librarian's page laid out as the user set it (LibrarianLook): their
/// picture or none, a background picture, each part at the top, middle or
/// bottom, and only the parts and numbers they want. Customize at the top
/// right opens the editor beside the page, which changes it as you go.
private struct CustomizedLibrarianPage: View {
    @Environment(AppModel.self) private var app
    @AppStorage(Looks.librarianKey) private var saved = Data()
    @State private var editing = false
    let stats: [HomeStat]

    private var look: LibrarianLook { LibrarianLook.load(saved) }

    private var lookBinding: Binding<LibrarianLook> {
        Binding(get: { LibrarianLook.load(saved) }, set: { Looks.saveLibrarianLook($0) })
    }

    var body: some View {
        let look = self.look
        let backdrop = Looks.image(look.background)
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: zoomed(32)) {
                    ForEach(look.layout) { block in
                        part(block, look: look)
                    }
                    if look.layout.isEmpty {
                        Text("Everything on this page is hidden. Customize puts it back.")
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: zoomed(1000), alignment: .leading)
                .padding(.horizontal, zoomed(32))
                .padding(.top, zoomed(28))
                .padding(.bottom, zoomed(48))
                .frame(maxWidth: .infinity)
            }
            .background {
                if let backdrop { BackdropPicture(image: backdrop, dim: look.backgroundDim) }
            }
            .environment(\.onPicture, backdrop != nil)
            .overlay(alignment: .topTrailing) {
                if !editing {
                    Button { withAnimation(.easeOut(duration: 0.18)) { editing = true } } label: {
                        Label("Customize", systemImage: "paintbrush")
                    }
                    .controlSize(.small)
                    .padding(zoomed(14))
                    .tip("Change the picture, the background, and where each part of this page sits")
                }
            }
            if editing {
                Divider()
                LibrarianLookEditor(look: lookBinding) {
                    withAnimation(.easeOut(duration: 0.18)) { editing = false }
                }
                .frame(width: zoomed(320))
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
    }

    @ViewBuilder
    private func part(_ block: LibrarianLook.Block, look: LibrarianLook) -> some View {
        switch block {
        case .greeting:
            LibrarianGreeting(name: look.greetingName, clock: look.greetingClock)
                .frame(maxWidth: zoomed(620), alignment: .leading)
        case .quote:
            LibrarianQuote(look: look)
                .frame(maxWidth: zoomed(620), alignment: .leading)
        case .picture:
            let image = look.picture == .own ? Looks.image(look.pictureFile) : Art.librarian
            if let image {
                // Room under it for what the bear says when it's poked.
                PokeablePicture(picture: image,
                                label: look.picture == .own ? "Your picture" : "The librarian bear, filing a card in a card catalogue",
                                lines: look.picture == .bear ? PokeLines.librarian : [],
                                side: look.pictureSize.side)
                    .padding(.bottom, look.picture == .bear ? zoomed(4) : 0)
            }
        case .about:
            LibrarianAbout(status: app.librarian, hidden: look.hiddenAbout)
                .frame(maxWidth: zoomed(620), alignment: .leading)
        case .numbers:
            let shown = stats.filter { !look.hiddenNumbers.contains($0.key) }
            if !shown.isEmpty {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: zoomed(170)), spacing: zoomed(14), alignment: .top)],
                    alignment: .leading,
                    spacing: zoomed(14)
                ) {
                    ForEach(shown) { HomeStatTile(stat: $0) }
                }
                .frame(maxWidth: zoomed(620), alignment: .leading)
            }
        case .github:
            GitHubActivityCard(user: look.githubUser)
                .frame(maxWidth: zoomed(760), alignment: .leading)
        case .settings:
            if let status = app.librarian {
                LibrarianSettings(status: status)
                    .frame(maxWidth: zoomed(620), alignment: .leading)
            }
        }
    }
}

/// The name, a line on what it does (more behind the ⓘ), and what it's
/// doing now.
private struct LibrarianAbout: View {
    let status: LibrarianStatus?
    /// The parts a customized page took off (LibrarianLook.AboutPart).
    var hidden: Set<LibrarianLook.AboutPart> = []

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            if !hidden.contains(.title) || !hidden.contains(.line) {
                HomeTitle(title: hidden.contains(.title) ? nil : "Librarian",
                          line: hidden.contains(.line) ? nil : "Keeps your projects tidy as your threads go.",
                          more: Self.more)
            }
            if let status, !hidden.contains(.status) {
                HomeStatusLine(text: LibrarianText.state(status), busy: status.state == .working)
            }
        }
    }

    static let more = "It files each thread in a project, writes down where the project's up to, and renames threads that have wandered off from their title. It takes a look after a thread's first message and when a turn ends, then catches up at most every 20 minutes while the thread keeps going. A catch-up after only a quick reply is skipped without asking the model. Each look is one short call to Haiku, not the model your threads use, on the Claude login with the most room in the Runs on pool, and counts towards its usage. It waits when they're all out of room, and threads in a private folder are never sent. A thread you take out of a project is never put back in it."
}

/// What can be changed about the librarian, here rather than only in
/// Settings: whether it's looking at all, and which pool's Claude logins
/// it runs on. The pool is the runner's small-jobs setting, which titles
/// share, so a change here shows in Settings › Models too.
private struct LibrarianSettings: View {
    @Environment(AppModel.self) private var app
    let status: LibrarianStatus

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(12)) {
            Text("Settings")
                .font(.system(size: zoomed(17), weight: .semibold))
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: zoomed(16), verticalSpacing: zoomed(12)) {
                GridRow {
                    Text("Look at threads")
                        .foregroundStyle(.secondary)
                    Toggle("Look at threads", isOn: Binding(get: { !status.paused }, set: { app.setLibrarianPaused(!$0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .disabled(app.isBusy(BusyKey.pauseLibrarian))
                        .tip(status.paused ? "Paused: what's queued waits. Turn it on to carry on" : "Turn it off to pause; what's queued waits")
                }
                if let settings = app.runnerSettings, settings.models.poolSupported {
                    GridRow {
                        Text("Runs on")
                            .foregroundStyle(.secondary)
                        Picker("Runs on", selection: Binding(get: { settings.models.pool }, set: { app.updateSettings(SettingsUpdate(pool: .some($0))) })) {
                            ForEach(app.claudePools) { pool in
                                Label(pool.title, systemImage: Pools.symbol(pool, accounts: app.accounts)).labelStyle(.titleAndIcon).tag(Optional(pool.id))
                            }
                            // What's set but can't take a look: None (from
                            // Settings), or a pool deleted since or with no
                            // Claude login. Shown so the picker still says
                            // what's set; not offered.
                            if let id = settings.models.pool, !app.claudePools.contains(where: { $0.id == id }) {
                                Label("\(id), which has no Claude login", systemImage: "exclamationmark.triangle").labelStyle(.titleAndIcon).tag(Optional(id))
                            } else if settings.models.pool == nil {
                                Label("No pool", systemImage: "nosign").labelStyle(.titleAndIcon).tag(String?.none)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                        .tip("Which pool's Claude logins it uses, the one with the most room. It waits when they're all out of room. Titles use the same pool (Settings › Models)")
                    }
                }
            }
            .font(.system(size: TypeScale.label))
            Button("More in Settings…") { app.openModelSettings() }
                .controlSize(.small)
                .tip("Private folders, whose threads are never sent anywhere")
        }
        .padding(.top, zoomed(8))
    }
}

/// The page's numbers, from the status the runner sends and what the app
/// already knows about projects and threads.
enum LibrarianStats {
    typealias Tile = HomeStat

    /// Every number, by its key, for the editor's switches: there even
    /// while the runner's away and the tiles aren't.
    static let names: [(key: String, title: String)] = [
        ("looks", "Looks today"), ("skipped", "Skipped today"), ("tokens", "Tokens today"),
        ("made", "Projects it made"), ("filed", "Threads it filed"), ("waiting", "Waiting"),
    ]

    static func tiles(_ status: LibrarianStatus, projects: [Project], threads: [ThreadSummary]) -> [Tile] {
        let made = projects.filter { $0.createdBy == .librarian && !$0.archived }.count
        let filed = threads.filter { $0.archivedAt == nil && $0.projects.contains { $0.by == .librarian } }.count
        return [
            Tile(value: "\(status.looksToday)", label: "Looks today",
                 help: "Threads it has looked at since midnight", key: "looks"),
            Tile(value: "\(status.skippedToday)", label: "Skipped today",
                 help: "Catch-ups after only a quick reply, skipped without asking the model", key: "skipped"),
            Tile(value: LibrarianText.tokens(status.tokensToday), label: "Tokens today",
                 help: "What today's looks sent and got back", key: "tokens"),
            Tile(value: "\(made)", label: made == 1 ? "Project it made" : "Projects it made",
                 help: "Projects the librarian started that aren't archived", key: "made"),
            Tile(value: "\(filed)", label: filed == 1 ? "Thread it filed" : "Threads it filed",
                 help: "Open threads the librarian put in a project", key: "filed"),
            Tile(value: "\(status.queue.count)", label: "Waiting",
                 help: "Threads queued for a look, listed in the sidebar", key: "waiting"),
        ]
    }
}

/// "Good morning, Wayne" at the top of a customized Librarian page, by the
/// time on this Mac, with the date and time under it. It changes on the
/// minute, so the morning turns to afternoon without a reload.
private struct LibrarianGreeting: View {
    let name: String
    let clock: Bool

    var body: some View {
        TimelineView(.everyMinute) { context in
            let now = context.date
            VStack(alignment: .leading, spacing: zoomed(6)) {
                Text(Greeting.text(hour: Calendar.current.component(.hour, from: now), name: name))
                    .font(.system(size: zoomed(28), weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if clock {
                    Text(now.formatted(.dateTime.weekday(.wide).month(.wide).day().hour().minute()))
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Today's quote on a customized Librarian page (Quotes): the words, who
/// said them and what they do, with where it's from in the tooltip. The
/// refresh button shows another for the rest of the day; the day turns at
/// 4 am on this Mac's clock. Right-click to copy it.
private struct LibrarianQuote: View {
    @Environment(\.onPicture) private var onPicture
    let look: LibrarianLook

    var body: some View {
        TimelineView(.everyMinute) { context in
            let day = Quotes.dayKey(context.date)
            if let quote = Quotes.pick(dayKey: day, skips: look.quoteSkips(on: day)) {
                HStack(alignment: .top, spacing: zoomed(12)) {
                    VStack(alignment: .leading, spacing: zoomed(6)) {
                        Text("\u{201C}\(quote.text)\u{201D}")
                            .font(.system(size: zoomed(17), weight: .medium, design: .serif))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        Text("\(quote.author), \(quote.role.lowercased())")
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(.secondary)
                    }
                    .tip(quote.source)
                    Spacer(minLength: 0)
                    Button {
                        var next = look
                        next.skipQuote(on: day)
                        withAnimation(.easeOut(duration: 0.2)) { Looks.saveLibrarianLook(next) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: zoomed(11), weight: .medium))
                            .frame(width: zoomed(22), height: zoomed(22))
                            .contentShape(Rectangle())
                    }
                    // Plain, so SwiftUI draws it rather than an NSButton
                    // that tracks the mouse in a loop of its own.
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .tip("Show another quote for today")
                    .accessibilityLabel("Show another quote")
                }
                .padding(.horizontal, zoomed(16))
                .padding(.vertical, zoomed(14))
                .tileBackground(onPicture, radius: zoomed(12))
                .id(quote.id)
                .transition(.opacity)
                .iconContextMenu {
                    Button("Copy Quote", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString("\u{201C}\(quote.text)\u{201D}\n\(quote.author)", forType: .string)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}
