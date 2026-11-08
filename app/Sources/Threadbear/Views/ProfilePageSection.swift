import AppKit
import SwiftUI
import ThreadbearCore

/// The Customize panel's Profile page section: a public page about you at
/// `<your site>/@<handle>`, with what's on it chosen part by part. Every part
/// starts off, and nothing goes until Save; the runner sends only the parts
/// turned on to your Convex backend (docs/guide.md, "The librarian").
struct ProfilePageSection: View {
    @Environment(AppModel.self) private var app
    let look: LibrarianLook
    @State private var draft = ProfilePageSettings()
    @State private var loaded = false
    @State private var confirmRemove = false

    private var saving: Bool { app.isBusy(BusyKey.saveProfilePage) }
    private var status: ProfilePageStatus? { app.profilePage }
    private var handleProblem: String? { draft.handle.isEmpty ? nil : ProfilePageSettings.handleProblem(draft.handle) }
    private var linksOK: Bool { draft.links.allSatisfy { ProfilePageSettings.linkProblem($0.url) == nil } }
    private var changed: Bool { status?.profile.map { !same($0, draft) } ?? true }

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
                saveSection
            }
        }
        .onAppear { app.loadProfilePage() }
        .onChange(of: app.profilePage) { _, new in
            guard !loaded, let new else { return }
            loaded = true
            if let saved = new.profile { draft = saved } else { draft.name = NSFullUserName() }
        }
    }

    // MARK: About you

    private var aboutSection: some View {
        Section {
            Toggle("Publish my profile page", isOn: $draft.published)
                .tip(draft.published ? "Public: anyone with the link can see it once you Save" : "Private: only you, signed in to your Threadbear site, can see it")
            TextField("Handle", text: Binding(get: { draft.handle }, set: { draft.handle = ProfilePageSettings.cleanHandle($0) }), prompt: Text("wayne"))
                .tip("Your page's address: lowercase letters, numbers and single hyphens, 3 to 30 of them")
            if let handleProblem {
                Text(handleProblem)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
            if let url = status?.url, let link = URL(string: url) {
                HStack {
                    Text(url)
                        .font(.system(size: TypeScale.label))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Spacer()
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(url, forType: .string)
                    }
                    .controlSize(.small)
                    .tip("Copy your profile page's link")
                    Button("Open") { _ = OpenGate.openLink(link) }
                        .controlSize(.small)
                        .tip("Open your profile page in the browser")
                }
            }
            TextField("Name", text: $draft.name)
                .tip("The name at the top of your page")
            TextField("Bio", text: $draft.bio, prompt: Text("One line about you"))
                .tip("A line under your name, up to 160 characters")
            ForEach(draft.links.indices, id: \.self) { i in
                HStack {
                    TextField("Title", text: $draft.links[i].title, prompt: Text("GitHub"))
                        .frame(maxWidth: zoomed(90))
                        .tip("What the link says on your page")
                    TextField("Address", text: $draft.links[i].url, prompt: Text("https://"))
                        .tip("Where it goes: an https:// address")
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
            if !linksOK {
                Text("Each link's address starts with https://")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
        } header: {
            HStack(spacing: zoomed(6)) {
                Text("Profile page")
                InfoTip("A page about you on your own Threadbear site, like a GitHub or Cursor profile. It's kept on your Convex backend, which serves it. Thread titles, prompts, replies, folders and project notes are never sent, and threads in a private folder aren't counted.")
            }
        }
    }

    // MARK: What's public

    private var partsSection: some View {
        Section("What's public") {
            ForEach(ProfilePageSettings.Part.allCases) { part in
                Toggle(part.title, isOn: Binding(get: { draft.shows(part) }, set: { draft.setShown($0, part) }))
                    .tip(part.tip)
            }
            if draft.shows(.github), GitHubUser.clean(look.githubUser).isEmpty {
                Text("Type your GitHub user name under GitHub activity above.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
            if draft.shows(.background), look.background == nil {
                Text("Choose a background photo above first.")
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

    // MARK: Save

    private var saveSection: some View {
        Section {
            HStack {
                Button(draft.published ? "Save and publish" : "Save") { app.saveProfilePage(draft, look: look) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.handle.isEmpty || handleProblem != nil || !linksOK)
                    .busy(saving)
                    .tip(draft.published ? "Send your page to your Convex backend, where anyone with the link can see it" : "Send it, kept private: only you can see it until you publish")
                Spacer()
                if status?.profile != nil {
                    Button("Take the page down", role: .destructive) { confirmRemove = true }
                        .disabled(saving)
                        .tip("Delete your page, its pictures and its handle from your Convex backend")
                }
            }
            if let problem = status?.problem {
                Text(problem)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.red)
            } else if changed, status?.profile != nil {
                Text("Changes here aren't on your page until you Save.")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            } else if let sent = status?.sentAt {
                Text("Up to date. Its numbers refresh by themselves within the hour. Sent \(Self.when(sent)).")
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
            }
        }
        .confirmationDialog("Take your profile page down?", isPresented: $confirmRemove) {
            Button("Take it down", role: .destructive) {
                app.removeProfilePage()
                draft = ProfilePageSettings()
                draft.name = NSFullUserName()
            }
        } message: {
            Text("Its page, pictures and handle are deleted from your Convex backend. Your Librarian page doesn't change.")
        }
    }

    /// What Save would change: the parts the app fills in on saving (the
    /// layout and pictures) don't count.
    private func same(_ a: ProfilePageSettings, _ b: ProfilePageSettings) -> Bool {
        var x = a, y = b
        for s in [\ProfilePageSettings.picturePath, \.backgroundPath, \.githubUser] as [WritableKeyPath<ProfilePageSettings, String?>] {
            x[keyPath: s] = nil
            y[keyPath: s] = nil
        }
        x.order = []
        y.order = []
        x.backgroundDim = nil
        y.backgroundDim = nil
        return x == y
    }

    private static func when(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .omitted, time: .shortened)
    }
}
