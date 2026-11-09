import AppKit
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// The Librarian page's Customize panel, beside the page so every change
/// shows as it's made: the picture (the bear, one of your own, or none),
/// a background picture and how faded it is, where each part sits and
/// whether it shows, which numbers show, and whose GitHub activity.
/// Pictures can be dropped on their wells as well as chosen.
struct LibrarianLookEditor: View {
    @Binding var look: LibrarianLook
    let done: () -> Void
    @State private var githubName = ""
    @State private var greetingName = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Customize")
                    .font(.system(size: zoomed(15), weight: .semibold))
                Spacer()
                Button("Done", action: done)
                    .keyboardShortcut(.cancelAction)
                    .controlSize(.small)
                    .tip("Close Customize. Changes are already saved")
            }
            .padding(.horizontal, zoomed(16))
            .padding(.vertical, zoomed(12))
            Divider()
            Form {
                greetingSection
                LookPictureSection(look: $look, bearTip: "Show the librarian bear")
                LookBackgroundSection(look: $look, slot: .librarian)
                quoteSection
                layoutSection
                titleSection
                numbersSection
                githubSection
                Section {
                    Button("Reset to the standard page") { reset() }
                        .disabled(look.isStandard)
                        .tip("Put the bear, the layout and every part back as Threadbear ships them, and take away your pictures")
                }
                ProfilePageSection(look: look)
            }
            .formStyle(PanelFormStyle())
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            githubName = look.githubUser
            greetingName = look.greetingName
        }
    }

    // MARK: Layout

    private var layoutSection: some View {
        Section("Layout") {
            ForEach(LibrarianLook.Block.allCases) { block in
                // The name on the left, then the switch and the place in
                // columns of their own, so they line up whatever the name
                // or place ("Top", "Middle") is.
                HStack(spacing: zoomed(10)) {
                    Text(block.title)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Toggle(block.title, isOn: Binding(get: { shown(block) }, set: { show($0, block) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .tip(Self.layoutTip(block))
                    Picker(block.title, selection: Binding(get: { look.place(block) }, set: { look.setPlace($0, for: block) })) {
                        ForEach(LibrarianLook.Place.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .frame(width: zoomed(92), alignment: .trailing)
                    .disabled(!shown(block))
                    .tip("Top, middle or bottom of the page")
                }
            }
        }
    }

    private static func layoutTip(_ block: LibrarianLook.Block) -> String {
        switch block {
        case .github: "Show your GitHub activity. Needs a user name, below"
        case .quote: "A quote a day, changing at 4 am, with a button for another"
        case .activity: "Threadbear activity: a year of days shaded by how many threads you started each day, as on your profile page. Threads in a private folder aren't counted"
        default: "Show or hide \(block.title.lowercased()) on the page"
        }
    }

    /// Whether the switch for a part is on. Greeting, quote and Threadbear
    /// activity have flags of their own, as they start off; the rest are on
    /// unless hidden.
    private func shown(_ block: LibrarianLook.Block) -> Bool {
        switch block {
        case .greeting: look.greetingShown
        case .quote: look.quoteShown
        case .activity: look.activityShown
        default: !look.hidden.contains(block)
        }
    }

    private func show(_ on: Bool, _ block: LibrarianLook.Block) {
        // The first time the greeting goes on, it suggests the Mac
        // account's first name, which can be changed or cleared.
        if block == .greeting, on, !look.greetingShown, look.greetingName.isEmpty {
            look.greetingName = Greeting.firstName(NSFullUserName())
            greetingName = look.greetingName
        }
        look.setShown(on, for: block)
    }

    // MARK: Greeting

    private var greetingSection: some View {
        Section {
            Toggle("Greet me", isOn: Binding(get: { look.greetingShown }, set: { show($0, .greeting) }))
                .tip("Good morning, afternoon, evening or night at the top of the page, by this Mac's clock")
            if look.greetingShown {
                LabeledContent("Name") {
                    TextField("Name", text: $greetingName, prompt: Text("No name"))
                        .labelsHidden()
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: zoomed(150))
                }
                    .onChange(of: greetingName) { _, typed in look.greetingName = typed }
                    .tip("The name it greets you by. Leave it empty for just Good morning")
                Toggle("Show the date and time", isOn: $look.greetingClock)
                    .tip("Today's date and the time under the greeting")
            }
        } header: {
            HStack(spacing: zoomed(6)) {
                Text("Greeting")
                InfoTip("Good morning from 5, good afternoon from 12, good evening from 5 pm and good night from 10 pm, by this Mac's own clock and time zone. It changes on the minute. The name stays on this Mac.")
            }
        }
    }

    // MARK: Quote

    private var quoteSection: some View {
        Section {
            Toggle("Show a quote a day", isOn: Binding(get: { look.quoteShown }, set: { show($0, .quote) }))
                .tip("A quote a day, changing at 4 am, with a button for another")
        } header: {
            HStack(spacing: zoomed(6)) {
                Text("Quote of the day")
                InfoTip("A quote from a writer, scientist, engineer, artist or athlete, the same all day and a new one at 4 am by this Mac's clock. The refresh button beside it shows another for the rest of the day, and right-click copies it. Hover it for where it's from. The quotes ship with Threadbear: nothing is fetched or sent, and none are from politicians, religious figures or tech founders. Move it with Layout.")
            }
        }
    }

    // MARK: Title

    private var titleSection: some View {
        Section("Title and status") {
            ForEach(LibrarianLook.AboutPart.allCases) { part in
                Toggle(part.title, isOn: Binding(get: { look.shows(part) }, set: { look.setShown($0, for: part) }))
                    .disabled(look.hidden.contains(.about))
                    .tip(Self.aboutTip(part))
            }
        }
    }

    private static func aboutTip(_ part: LibrarianLook.AboutPart) -> String {
        switch part {
        case .title: "Show or hide the word Librarian at the top"
        case .line: "Show or hide the line under the title, Keeps your projects tidy as your threads go"
        case .status: "Show or hide what the librarian is doing now"
        }
    }

    // MARK: Numbers

    private var numbersSection: some View {
        Section("Numbers") {
            ForEach(LibrarianStats.names, id: \.key) { number in
                Toggle(number.title, isOn: Binding(
                    get: { !look.hiddenNumbers.contains(number.key) },
                    set: { if $0 { look.hiddenNumbers.remove(number.key) } else { look.hiddenNumbers.insert(number.key) } }
                ))
                .disabled(look.hidden.contains(.numbers))
                .tip("Show or hide \(number.title.lowercased())")
            }
        }
    }

    // MARK: GitHub

    private var githubSection: some View {
        Section {
            LabeledContent("User name") {
                TextField("User name", text: $githubName, prompt: Text("octocat"))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: zoomed(150))
            }
                .onSubmit { saveGitHubName() }
                .onChange(of: githubName) { _, typed in
                    // Saved as it's typed once it's a real name, or cleared.
                    let clean = GitHubUser.clean(typed)
                    if typed.isEmpty || !clean.isEmpty { look.githubUser = clean }
                }
                .tip("Your GitHub user name, or a link to your profile")
            if !githubName.isEmpty, GitHubUser.clean(githubName).isEmpty {
                Text("That isn't a GitHub user name.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
        } header: {
            HStack(spacing: zoomed(6)) {
                Text("GitHub activity")
                InfoTip("Your public contributions for each year, as on your GitHub profile. Fetched from the GitHub Contributions API (github-contributions-api.jogruber.de), which reads that calendar; only the user name is sent, and no token. Private work counts only if your profile shows private contributions.")
            }
        }
    }

    private func saveGitHubName() {
        githubName = GitHubUser.clean(githubName)
        look.githubUser = githubName
    }

    private func reset() {
        look = .standard
        githubName = ""
        greetingName = ""
    }
}
