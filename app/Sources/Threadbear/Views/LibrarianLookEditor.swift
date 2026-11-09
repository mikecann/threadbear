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
    @State private var problem: String?

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
                pictureSection
                backgroundSection
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

    // MARK: Picture

    private var pictureSection: some View {
        Section("Picture") {
            SegmentedChoice(options: LibrarianLook.Picture.allCases, selection: look.picture, title: \.title, tip: Self.pictureTip) { pick($0) }
            if look.picture == .own {
                PictureWell(image: Looks.image(look.pictureFile), empty: "Drop a picture here") { url in
                    importPicture(url)
                }
                HStack {
                    Button(look.pictureFile == nil ? "Choose…" : "Replace…") {
                        if let url = Looks.choosePicture(prompt: "Use Picture") { importPicture(url) }
                    }
                    .tip("Pick a picture from your Mac. A copy is kept, so the original can move")
                    if look.pictureFile != nil {
                        Button("Remove") { look.pictureFile = nil; look.picture = .bear }
                            .tip("Go back to the bear and delete the copy")
                    }
                }
                .controlSize(.small)
            }
            if look.picture != .none {
                LabeledContent("Size") {
                    Picker("Size", selection: $look.pictureSize) {
                        ForEach(LibrarianLook.PictureSize.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                .tip("How big the picture is on the page")
            }
            if let problem {
                Text(problem)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.red)
            }
        }
    }

    private static func pictureTip(_ picture: LibrarianLook.Picture) -> String {
        switch picture {
        case .bear: "Show the librarian bear"
        case .own: "Show a picture of your own"
        case .none: "No picture on the page"
        }
    }

    private func pick(_ picture: LibrarianLook.Picture) {
        // Your picture with none chosen yet asks for one straight away.
        if picture == .own, look.pictureFile == nil {
            guard let url = Looks.choosePicture(prompt: "Use Picture") else { return }
            importPicture(url)
            return
        }
        look.picture = picture
    }

    private func importPicture(_ url: URL) {
        guard let name = Looks.importPicture(from: url, maxSide: 1200, prefix: "picture") else {
            problem = "That file isn't a picture Threadbear can read."
            return
        }
        problem = nil
        look.pictureFile = name
        look.picture = .own
        look.setShown(true, for: .picture)
    }

    // MARK: Background

    private var backgroundSection: some View {
        Section("Background") {
            PictureWell(image: Looks.image(look.background), empty: "Drop a photo here", fill: true) { url in
                importBackground(url)
            }
            HStack {
                Button(look.background == nil ? "Choose…" : "Replace…") {
                    if let url = Looks.choosePicture(prompt: "Use as Background") { importBackground(url) }
                }
                .tip("Pick a photo to fill the page behind everything")
                if look.background != nil {
                    Button("Remove") { look.background = nil }
                        .tip("Take the background away and delete the copy")
                }
            }
            .controlSize(.small)
            if look.background != nil {
                LabeledContent("Fade") {
                    Slider(value: $look.backgroundDim, in: 0...0.9)
                        .tip("How much the page's own colour covers the photo, so text stays easy to read in light and dark")
                }
            }
        }
    }

    private func importBackground(_ url: URL) {
        guard let name = Looks.importPicture(from: url, maxSide: 2880, prefix: "background") else {
            problem = "That file isn't a picture Threadbear can read."
            return
        }
        problem = nil
        look.background = name
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
        default: "Show or hide \(block.title.lowercased()) on the page"
        }
    }

    /// Whether the switch for a part is on. Greeting has its own flag, as
    /// it starts off; the rest are on unless hidden.
    private func shown(_ block: LibrarianLook.Block) -> Bool {
        block == .greeting ? look.greetingShown : !look.hidden.contains(block)
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
        problem = nil
    }
}

/// A picture's spot in the editor: the picture, or a dashed box to drop one
/// on. A dropped file is handed over to be copied in.
private struct PictureWell: View {
    let image: NSImage?
    let empty: String
    var fill = false
    let dropped: (URL) -> Void
    @State private var targeted = false

    var body: some View {
        ZStack {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: fill ? .fill : .fit)
                    .frame(maxWidth: .infinity, maxHeight: zoomed(120))
                    .clipShape(RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
            } else {
                Text(empty)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: zoomed(64))
            }
        }
        .frame(maxWidth: .infinity)
        .overlay {
            RoundedRectangle(cornerRadius: zoomed(8), style: .continuous)
                .strokeBorder(targeted ? Color.accentColor : Color.primary.opacity(image == nil ? 0.2 : 0),
                              style: StrokeStyle(lineWidth: targeted ? 2 : 1, dash: image == nil && !targeted ? [4, 3] : []))
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first else { return false }
            dropped(url)
            return true
        } isTargeted: { targeted = $0 }
        .tip("Drop a picture from Finder to use it")
    }
}

/// A row of choices drawn as one segmented control, out of plain SwiftUI
/// buttons. The AppKit segmented Picker in this panel took clicks without
/// changing anything on Wayne's Mac (8 Nov), and a control that runs its own
/// mouse loop can't be pressed by the automation either; these are ordinary
/// buttons, so a click always lands and an agent can press one by its tip.
struct SegmentedChoice<Option: Hashable & Identifiable>: View {
    let options: [Option]
    let selection: Option
    let title: KeyPath<Option, String>
    let tip: (Option) -> String
    let choose: (Option) -> Void

    var body: some View {
        HStack(spacing: zoomed(2)) {
            ForEach(options) { option in
                let on = option == selection
                Button { if !on { choose(option) } } label: {
                    Text(option[keyPath: title])
                        .font(.system(size: TypeScale.label, weight: on ? .medium : .regular))
                        .lineLimit(1)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, zoomed(4))
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: zoomed(6), style: .continuous)
                                    .fill(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .tip(tip(option))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(zoomed(2))
        .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
        .animation(.easeOut(duration: 0.12), value: selection)
    }
}
