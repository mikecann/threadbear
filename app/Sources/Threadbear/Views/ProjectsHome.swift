import AppKit
import SwiftUI
import ThreadbearCore

/// The Projects page: what clicking Projects in the activity bar shows in
/// the detail area. A card per project, newest activity first, with its
/// icon, where it's up to and what its threads are doing. A card opens the
/// project's page; the sidebar's Projects view lists the threads.
struct ProjectsHome: View {
    @Environment(AppModel.self) private var app
    /// Settings > General > Look. Off, the page is as it ships, whatever
    /// look is saved; the look is kept for when it's back on.
    @AppStorage(Looks.projectsOnKey) private var customizable = false

    var body: some View {
        if customizable {
            CustomizedProjectsPage()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: zoomed(22)) {
                    ProjectsHeader(searchable: true)
                    ProjectsGrid(searchable: true, hidden: [])
                }
                .frame(maxWidth: zoomed(1160), alignment: .leading)
                .padding(.horizontal, zoomed(32))
                .padding(.top, zoomed(28))
                .padding(.bottom, zoomed(48))
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// "4 projects · 2 working · 1 needs you", each thread counted once.
    static func summary(_ cards: [ProjectCard], overall: ProjectCardStatus) -> String {
        var parts = [cards.count == 1 ? "1 project" : "\(cards.count) projects"]
        if overall.working > 0 { parts.append("\(overall.working) working") }
        if overall.needsYou > 0 { parts.append("\(overall.needsYou) needs you") }
        return parts.joined(separator: " · ")
    }

    /// The search as typed, or nothing while the search box is hidden, so
    /// a query left in it can't quietly filter the cards.
    @MainActor
    static func query(_ app: AppModel, searchable: Bool) -> String {
        searchable ? app.projectSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }
}

/// The Projects page laid out as the user set it (ProjectsLook): a
/// picture of their own or none, a background photo, the title and
/// search and the cards each at the top, middle or bottom, or hidden, and
/// which parts of each card show.
private struct CustomizedProjectsPage: View {
    @AppStorage(Looks.projectsKey) private var saved = Data()

    var body: some View {
        // `saved` redraws the page as the panel changes the look.
        let look = ProjectsLook.load(saved)
        let searchable = look.shows(.header)
        CustomizedPage(backdrop: Looks.image(look.background), dim: look.backgroundDim, focus: look.backgroundFocus, slot: .projects,
                       filled: Set(look.layout.map(look.place)), pinsPlaces: true, maxWidth: 1160,
                       customizeTip: "Change the picture, the background, where each part of this page sits, and what each card shows") { place in
            ForEach(look.layout.filter { look.place($0) == place }) { block in
                switch block {
                case .picture:
                    if let image = Looks.image(look.pictureFile) {
                        PokeablePicture(picture: image, label: "Your picture", lines: [], side: look.pictureSize.side)
                    }
                case .header:
                    ProjectsHeader(searchable: searchable)
                case .cards:
                    ProjectsGrid(searchable: searchable, hidden: look.hiddenCardParts)
                }
            }
        } buttons: {
            EmptyView()
        } editor: { done in
            ProjectsLookEditor(look: Looks.projectsBinding(), done: done)
        }
    }
}

/// The title, how many projects and what they're doing, the search and
/// New project.
private struct ProjectsHeader: View {
    @Environment(AppModel.self) private var app
    let searchable: Bool

    var body: some View {
        @Bindable var app = app
        let sections = app.projectSections
        let all = ProjectCard.build(sections)
        let query = ProjectsHome.query(app, searchable: searchable)
        let cards = ProjectCard.matching(all, query)
        let searching = !query.isEmpty
        HStack(alignment: .firstTextBaseline, spacing: zoomed(10)) {
            Text("Projects")
                .font(.system(size: zoomed(24), weight: .semibold))
                .fixedSize()
            // In a narrow window the summary is what gives way: one
            // line cut short, rather than wrapping under the title
            // or squeezing the search, whose width would otherwise
            // jump as the summary's length changes with each key.
            Text(searching ? ProjectCard.matchCount(cards.count, of: all.count)
                           : ProjectsHome.summary(all, overall: ProjectCard.overall(sections)))
                .font(.system(size: TypeScale.label))
                .foregroundStyle(Color(nsColor: Theme.faintText))
                .monospacedDigit()
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            SearchField(text: $app.projectSearchQuery, prompt: "Search projects", focusOnAppear: true)
                .frame(minWidth: zoomed(120), maxWidth: zoomed(240))
                .layoutPriority(1)
                // Return opens the top result, Escape clears, so a
                // project is a few keys away from this page.
                .onSubmit { if searching, let first = cards.first { app.openProjectPage(first.project.id) } }
                .onExitCommand { app.projectSearchQuery = "" }
            Button { app.newProject(with: nil) } label: {
                Label("New project", systemImage: "plus")
            }
            .fixedSize()
            .busy(app.isBusy(BusyKey.newProject))
            .tip("Make a new project")
        }
    }
}

/// A card per project that matches the search, or a line saying why
/// there are none.
private struct ProjectsGrid: View {
    @Environment(AppModel.self) private var app
    let searchable: Bool
    let hidden: Set<ProjectsLook.CardPart>

    var body: some View {
        let all = ProjectCard.build(app.projectSections)
        let cards = ProjectCard.matching(all, ProjectsHome.query(app, searchable: searchable))
        if all.isEmpty {
            Text("No projects yet. The librarian makes them as threads run, or you can make one.")
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
        } else if cards.isEmpty {
            Text("No projects match that.")
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
        } else {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: zoomed(240), maximum: zoomed(340)), spacing: zoomed(20), alignment: .top)],
                alignment: .leading,
                spacing: zoomed(24)
            ) {
                ForEach(cards) { card in
                    ProjectCardView(card: card, hidden: hidden)
                }
            }
        }
    }
}

/// One project's card: its icon on a wide tile, then its title, what its
/// threads are doing, and the first lines of its state.
private struct ProjectCardView: View {
    @Environment(AppModel.self) private var app
    let card: ProjectCard
    /// What Customize took off the card. Empty: the card as it ships.
    var hidden: Set<ProjectsLook.CardPart> = []
    @State private var hovering = false

    var body: some View {
        Button { app.openProjectPage(card.project.id) } label: {
            VStack(alignment: .leading, spacing: zoomed(10)) {
                let showsCount = card.status.open > 0 && !hidden.contains(.threads)
                if !hidden.contains(.art) {
                    ProjectArt(project: card.project)
                        .overlay(alignment: .topTrailing) {
                            if showsCount {
                                ThreadCount(count: card.status.open)
                                    .padding(zoomed(8))
                            }
                        }
                }
                VStack(alignment: .leading, spacing: zoomed(5)) {
                    HStack(spacing: zoomed(8)) {
                        Text(card.project.title)
                            .font(.system(size: zoomed(15), weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        // With no tile to sit on, the count goes by the name.
                        if showsCount && hidden.contains(.art) {
                            Spacer(minLength: 0)
                            ThreadCount(count: card.status.open)
                        }
                    }
                    if !hidden.contains(.status) {
                        StatusLine(card: card, now: app.now)
                    }
                    if !hidden.contains(.state), !card.project.state.isEmpty {
                        Text(Self.firstLines(card.project.state))
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, zoomed(2))
                    }
                }
                .padding(.horizontal, zoomed(2))
            }
            .contentShape(Rectangle())
            .scaleEffect(hovering ? 1.015 : 1)
            .animation(.easeOut(duration: 0.15), value: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .tip("Open \(card.project.title)")
        .iconContextMenu { ProjectMenu(project: card.project) }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// The state is markdown-ish prose the librarian writes; the card wants
    /// its opening sentences on one run, without the line breaks.
    static func firstLines(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

/// The card's picture: the project's icon in the middle of a wide tile.
/// An icon that's a picture also fills the tile behind it, blurred, so
/// each project's card takes its colour from its own icon; a symbol or a
/// letter sits on a quiet grey, as in the sidebar.
private struct ProjectArt: View {
    let project: Project

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: zoomed(12), style: .continuous)
        Color.primary.opacity(0.05)
            .overlay {
                if let path = project.icon?.image?.path, let image = ProjectIconImages.image(at: path) {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .blur(radius: zoomed(28))
                        .opacity(0.55)
                        .saturation(1.1)
                }
            }
            .overlay {
                ProjectIconView(project: project, size: 56)
                    .shadow(color: .black.opacity(project.icon?.image != nil ? 0.25 : 0), radius: zoomed(8), y: zoomed(3))
            }
            .aspectRatio(2, contentMode: .fit)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.primary.opacity(0.08)))
    }
}

/// How many open threads it has, in the tile's corner.
private struct ThreadCount: View {
    let count: Int

    var body: some View {
        HStack(spacing: zoomed(4)) {
            Image(systemName: "bubble.left.and.bubble.right")
            Text("\(count)").monospacedDigit()
        }
        .font(.system(size: TypeScale.sidebarMeta, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, zoomed(7))
        .padding(.vertical, zoomed(3))
        .background(.regularMaterial, in: Capsule())
        .tip(count == 1 ? "1 open thread" : "\(count) open threads")
    }
}

/// What its threads are doing, most pressing first, in the sidebar's
/// colours: orange for waiting on Mike, the accent and its spinner for
/// working. A quiet project says when it was last active instead.
private struct StatusLine: View {
    let card: ProjectCard
    let now: Date

    var body: some View {
        let status = card.status
        HStack(alignment: .firstTextBaseline, spacing: zoomed(5)) {
            if status.isQuiet {
                Text("Last active \(RelativeTime.short(card.lastActivityAt, now: now))")
                    .foregroundStyle(Color(nsColor: Theme.faintText))
            } else {
                ForEach(Array(status.parts.enumerated()), id: \.offset) { index, part in
                    if index > 0 { Text("·").foregroundStyle(Color(nsColor: Theme.faintText)) }
                    if case .working = part {
                        SpinnerMark(color: .controlAccentColor)
                            .frame(width: zoomed(11), height: zoomed(11))
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + zoomed(4) }
                    }
                    Text(part.text).foregroundStyle(color(of: part))
                }
            }
        }
        .font(.system(size: TypeScale.sidebarMeta + 1, weight: .medium))
        .lineLimit(1)
    }

    private func color(of part: ProjectCardStatus.Part) -> Color {
        switch part {
        case .needsYou: Color(nsColor: Theme.needsYou)
        case .working: .accentColor
        case .failed: Color(nsColor: Theme.failed)
        case .unread: .secondary
        }
    }
}
