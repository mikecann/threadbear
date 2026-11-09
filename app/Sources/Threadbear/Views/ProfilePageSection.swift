import AppKit
import SwiftUI
import ThreadbearCore

/// The Customize panel's Profile page section: a public page about you on
/// your own Threadbear site, at /profile, or its front page if you choose.
/// A site is one person's, so there's no handle to pick. It saves as you
/// change it, like the rest of Customize; Publish is the one choice that
/// shows it to anyone. Every part starts off, and the runner sends only the
/// parts turned on to your Convex backend (docs/guide.md, "The librarian").
struct ProfilePageSection: View {
    @Environment(AppModel.self) private var app
    let look: LibrarianLook
    @State private var draft = ProfilePageSettings()
    /// What the runner last had, as the draft started from it: the draft
    /// follows the runner until it's edited, then keeps the edits.
    @State private var baseline: ProfilePageSettings?
    @State private var pending: Task<Void, Never>?
    @State private var confirmRemove = false

    private var saving: Bool { app.isBusy(BusyKey.saveProfilePage) || pending != nil }
    private var status: ProfilePageStatus? { app.profilePage }

    var body: some View {
        Group {
            if app.profilePageMissing {
                Section("Profile page") {
                    Text("This runner is older than the profile page. Update Threadbear to make one.")
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                }
            } else {
                aboutSection
                partsSection
                if draft.shows(.numbers) { numbersSection }
                if draft.shows(.projects) { projectsSection }
                footerSection
            }
        }
        // The app may already hold the runner's answer from an earlier
        // opening, and asking again then changes nothing, so the draft takes
        // what's held at once as well as what comes back.
        .onAppear {
            if let held = app.profilePage { adopt(held) }
            app.loadProfilePage()
        }
        .onChange(of: app.profilePage) { _, new in
            if let new { adopt(new) }
        }
        .onChange(of: draft) { _, _ in saveSoon() }
        // The page's picture, background, layout and GitHub name come from
        // the Librarian page's look, so a change there goes too.
        .onChange(of: look) { _, _ in
            if status?.profile != nil { saveSoon(force: true) }
        }
    }

    private func adopt(_ status: ProfilePageStatus) {
        let fresh = status.profile ?? Self.blank
        if let baseline, !same(baseline, draft), !same(fresh, draft) { return }
        draft = fresh
        baseline = fresh
    }

    /// A moment after the last change, so typing a name sends once. Only
    /// when the panel differs from what the runner has (or the Librarian
    /// page's look changed), so the runner's answer coming back, which
    /// sets the draft again, doesn't send it again.
    private func saveSoon(force: Bool = false) {
        guard baseline != nil else { return }
        pending?.cancel()
        pending = nil
        if !force, same(draft, status?.profile ?? Self.blank) { return }
        pending = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            pending = nil
            app.saveProfilePage(draft, look: look)
        }
    }

    private static var blank: ProfilePageSettings {
        var s = ProfilePageSettings()
        s.name = NSFullUserName()
        return s
    }

    // MARK: About you

    private var aboutSection: some View {
        Section {
            Toggle("Publish my profile page", isOn: $draft.published)
                .tip(draft.published ? "Public: anyone with the link can see it. Turn it off to keep it to yourself" : "Off: only you can see it, in a browser signed in to your Threadbear site")
            if draft.published {
                Toggle("Show it on my site's front page", isOn: $draft.home)
                    .tip("Visitors to your site's address see this page first. Signed in, you still get your threads there")
            }
            // Open always goes to the profile page. With it on the front
            // page too, Open site shows what visitors see at the site's
            // address (signed in, that's your threads).
            // Two rows, so it's clear what each address shows: the
            // profile page always, at /profile, and while it's on the front
            // page, the site's address as well.
            if let profile = status?.profileURL {
                ProfileLinkRow(title: "Profile page", url: profile,
                               note: "Opens your profile, signed in or not.",
                               what: "your profile page")
            }
            if let site = status?.siteURL {
                ProfileLinkRow(title: "Front page", url: site,
                               note: "Visitors see your profile here. Signed in, you see your threads.",
                               what: "your site's front page")
            }
            LabeledContent("Name") {
                TextField("Name", text: $draft.name, prompt: Text("Your name"))
                    .labelsHidden()
                    .frame(maxWidth: zoomed(170))
            }
            .tip("The name at the top of your page")
            LabeledContent("Bio") {
                TextField("Bio", text: $draft.bio, prompt: Text("One line about you"))
                    .labelsHidden()
                    .frame(maxWidth: zoomed(170))
            }
            .tip("A line under your name, up to 160 characters")
            ForEach(draft.links.indices, id: \.self) { i in
                HStack {
                    TextField("Title", text: $draft.links[i].title, prompt: Text("GitHub"))
                        .frame(maxWidth: zoomed(90))
                        .tip("What the link says on your page")
                    TextField("Address", text: $draft.links[i].url, prompt: Text("https://"))
                        .tip("Where it goes: an https:// address. It shows once the address is complete")
                    Button {
                        draft.links.remove(at: i)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .tip("Take this link off")
                }
            }
            if draft.links.count < ProfilePageSettings.linksMax {
                Button("Add a link") { draft.links.append(.init(title: "", url: "")) }
                    .tip("Up to \(ProfilePageSettings.linksMax) links, such as X, GitHub, LinkedIn or your site")
            }
        } header: {
            HStack(spacing: zoomed(6)) {
                Text("Profile page")
                InfoTip("A page about you on your own Threadbear site. It's kept on your Convex backend, which serves it, and saves as you change it. Thread titles, prompts, replies, folders and project notes are never sent, and threads in a private folder aren't counted.")
            }
        }
    }

    // MARK: What's public

    private var partsSection: some View {
        Section("What's on it") {
            ForEach(ProfilePageSettings.offered) { part in
                Toggle(part.title, isOn: Binding(get: { draft.shows(part) }, set: { draft.setShown($0, part) }))
                    .tip(part.tip)
            }
            if draft.shows(.github), GitHubUser.clean(look.githubUser).isEmpty {
                Text("Type your GitHub user name under GitHub activity above.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var numbersSection: some View {
        Section("Numbers on your page") {
            ForEach(ProfilePageSettings.numberChoices, id: \.key) { number in
                Toggle(number.title, isOn: Binding(
                    get: { draft.numbers.contains(number.key) },
                    set: { on in
                        if on { draft.numbers.append(number.key) } else { draft.numbers.removeAll { $0 == number.key } }
                    }
                ))
                .tip("Show \(number.title.lowercased()) on your page")
            }
        }
    }

    private var projectsSection: some View {
        Section("Projects on your page") {
            let live = app.projects.filter { !$0.archived }
            if live.isEmpty {
                Text("No projects yet.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
            ForEach(live) { project in
                Toggle(project.title, isOn: Binding(
                    get: { draft.projectIds.contains(project.id) },
                    set: { on in
                        if on { draft.projectIds.append(project.id) } else { draft.projectIds.removeAll { $0 == project.id } }
                    }
                ))
                .disabled(!draft.projectIds.contains(project.id) && draft.projectIds.count >= 12)
                .tip("Show this project's title and thread count. Its goals, state, notes and folders stay private")
            }
        }
    }

    // MARK: Where it stands

    private var footerSection: some View {
        Section {
            HStack(spacing: zoomed(8)) {
                if saving {
                    ProgressView().controlSize(.small)
                    Text("Saving…")
                } else if let problem = status?.problem {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.red)
                    Text(problem).foregroundStyle(.red)
                } else if status?.profile == nil {
                    Text("Nothing's sent until you change something here.")
                } else if status?.profile?.published == true {
                    Image(systemName: "checkmark.circle").foregroundStyle(.secondary)
                    Text("Saved and public. Its numbers refresh by themselves within the hour.")
                } else {
                    Image(systemName: "lock").foregroundStyle(.secondary)
                    Text("Saved. Only you can see it until you publish it.")
                }
                Spacer(minLength: 0)
            }
            .font(.system(size: TypeScale.label))
            .foregroundStyle(.secondary)
            if status?.profile != nil {
                Button("Take the page down", role: .destructive) { confirmRemove = true }
                    .disabled(saving)
                    .tip("Delete your page and its pictures from your Convex backend")
            }
        }
        .confirmationDialog("Take your profile page down?", isPresented: $confirmRemove) {
            Button("Take it down", role: .destructive) {
                pending?.cancel()
                pending = nil
                baseline = nil
                draft = Self.blank
                app.removeProfilePage()
            }
        } message: {
            Text("Its page and pictures are deleted from your Convex backend. Your Librarian page doesn't change.")
        }
    }

    /// The same page, as far as what's sent goes: the parts the app fills in
    /// on saving (the layout and pictures) and links still being typed
    /// don't count.
    private func same(_ a: ProfilePageSettings, _ b: ProfilePageSettings) -> Bool {
        func core(_ s: ProfilePageSettings) -> ProfilePageSettings {
            var x = s.sendable
            x.order = []
            x.picturePath = nil
            x.backgroundPath = nil
            x.backgroundDim = nil
            x.githubUser = nil
            return x
        }
        return core(a) == core(b)
    }
}

/// One of the profile page's addresses: what it is, the address, and Copy
/// and Open, with a line on what someone sees there.
private struct ProfileLinkRow: View {
    let title: String
    let url: URL
    let note: String
    let what: String

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(4)) {
            HStack(spacing: zoomed(8)) {
                Text(title)
                Spacer(minLength: zoomed(8))
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url.absoluteString, forType: .string)
                }
                .controlSize(.small)
                .tip("Copy the link to \(what)")
                Button("Open") { _ = OpenGate.openLink(url) }
                    .controlSize(.small)
                    .tip("Open \(what) in the browser")
            }
            Text(url.absoluteString)
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Text(note)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
