import AppKit
import SwiftUI
import ThreadbearCore

/// Settings > Profiles: this Mac's whole Threadbear setups, such as Work
/// beside Personal (AppProfile, runner/src/profiles.ts). Each has its own
/// runner, threads, Convex and logins. Making one runs setup for it in the
/// background (its Convex sign-in opens in the browser); its progress shows
/// on its row. Switching opens the app again on the other profile.
struct ProfilesSettings: View {
    @Environment(AppModel.self) private var app
    @State private var profiles: [ProfileInfo] = []
    @State private var problem: String?
    @State private var making = false
    @State private var renaming: ProfileInfo?
    @State private var newName = ""
    @State private var removing: ProfileInfo?
    @State private var poll: Task<Void, Never>?

    var body: some View {
        Form {
            SettingsSection("Profiles",
                            about: "A profile is a whole Threadbear of its own on this Mac, such as Work beside Personal: its own threads, projects, skills, notes, Claude and Codex logins, and its own Convex account and backend, so work never mixes with personal. The app shows one at a time; switching opens it on the other. Keyboard shortcuts and how the app looks are shared.",
                            ask: "make, change or remove a profile.") {
                ForEach(profiles) { profile in
                    ProfileRow(profile: profile, current: AppProfile.current?.id == profile.id,
                               rename: { renaming = profile; newName = profile.name },
                               remove: { removing = profile },
                               retry: { team in retry(profile, team: team) },
                               refresh: refresh)
                }
                if let problem {
                    Text(problem).foregroundStyle(.red).font(.system(size: TypeScale.label))
                }
                HStack {
                    Spacer()
                    Button("New Profile…") { making = true }
                        .tip("Make a profile with its own Convex account, logins and threads")
                }
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
        .scrollIndicators(.never)
        .scrollDisabled(true)
        .onAppear { refresh() }
        .onDisappear { poll?.cancel() }
        .sheet(isPresented: $making) {
            NewProfileSheet { name, project in create(name: name, project: project) }
        }
        .alert("Rename \(renaming?.name ?? "")", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename") { if let renaming { rename(renaming, to: newName) } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Remove \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove, Keep Its Files") { if let removing { remove(removing, deleteFiles: false) } }
            Button("Remove and Delete Its Files", role: .destructive) { if let removing { remove(removing, deleteFiles: true) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its runner stops and it leaves the list. Its Convex backend stays in your Convex account; delete it there if you don't need it. Deleting its files deletes its threads, notes and logins on this Mac.")
        }
    }

    private func refresh() {
        guard let client = app.client else { return }
        Task {
            do {
                profiles = try await client.profiles()
                problem = nil
            } catch {
                problem = "Couldn't list the profiles: \(error.localizedDescription)"
            }
            // While one is being set up, look again every two seconds.
            if profiles.contains(where: { $0.job?.isRunning == true }) {
                poll?.cancel()
                poll = Task {
                    try? await Task.sleep(for: .seconds(2))
                    if !Task.isCancelled { refresh() }
                }
            }
        }
    }

    private func act(_ what: String, _ body: @escaping (RPCClient) async throws -> Void) {
        guard let client = app.client else { return }
        Task {
            do {
                try await body(client)
                problem = nil
            } catch {
                problem = "Couldn't \(what): \(error.localizedDescription)"
            }
            refresh()
        }
    }

    private func create(name: String, project: String) {
        act("make the profile") { try await $0.createProfile(name: name, project: project, team: nil) }
    }

    private func retry(_ profile: ProfileInfo, team: String?) {
        act("set \(profile.name) up") { try await $0.retryProfile(id: profile.id, team: team) }
    }

    private func rename(_ profile: ProfileInfo, to name: String) {
        act("rename \(profile.name)") { try await $0.renameProfile(id: profile.id, name: name) }
    }

    private func remove(_ profile: ProfileInfo, deleteFiles: Bool) {
        act("remove \(profile.name)") { try await $0.removeProfile(id: profile.id, deleteFiles: deleteFiles) }
    }
}

private struct ProfileRow: View {
    @Environment(AppModel.self) private var app
    let profile: ProfileInfo
    let current: Bool
    let rename: () -> Void
    let remove: () -> Void
    let retry: (String?) -> Void
    let refresh: () -> Void
    @State private var colourChanged = 0

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            HStack(spacing: zoomed(8)) {
                Circle().fill(AppProfile.colour(profile.entry) ?? Color.secondary.opacity(0.4)).frame(width: zoomed(10), height: zoomed(10))
                    .id(colourChanged)
                VStack(alignment: .leading, spacing: zoomed(2)) {
                    HStack(spacing: zoomed(6)) {
                        Text(profile.name).font(.system(size: TypeScale.body, weight: .semibold))
                        if current { Text("This one").font(.system(size: TypeScale.small)).foregroundStyle(.secondary) }
                    }
                    Text(status).font(.system(size: TypeScale.small)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if !current, profile.running, profile.job?.isRunning != true {
                    Button("Switch") { AppProfile.switchTo(profile.entry, app: app) }
                        .disabled(!AppProfile.canSwitch)
                        .tip("Open Threadbear on \(profile.name)")
                }
                IconMenu {
                    menu
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .tip("More for \(profile.name)")
            }
            if let job = profile.job { JobView(job: job, retry: retry) }
        }
        .padding(.vertical, zoomed(2))
    }

    private var status: String {
        let runner = profile.running ? "running" : "not running"
        let convex = profile.convexUrl.flatMap { URL(string: $0)?.host } ?? "no Convex yet"
        return "\(runner) · \(convex) · port \(profile.port)"
    }

    @ViewBuilder private var menu: some View {
        if !current {
            Button("Switch to \(profile.name)", systemImage: "arrow.left.arrow.right") { AppProfile.switchTo(profile.entry, app: app) }
                .disabled(!AppProfile.canSwitch || !profile.running)
        }
        IconMenu("Colour", systemImage: "paintpalette") {
            ForEach(Profiles.colours, id: \.self) { name in
                Button(name.capitalized, systemImage: AppProfile.colourName(profile.entry) == name ? "checkmark.circle.fill" : "circle.fill") {
                    AppProfile.setColour(name, for: profile.entry)
                    colourChanged += 1
                }
            }
        }
        if !profile.isPersonal {
            Button("Rename…", systemImage: "pencil") { rename() }
            Divider()
            Button("Sign In to Claude…", systemImage: "person.badge.key") { ProfileLogins.open(.claude, for: profile) }
            Button("Sign In to Codex…", systemImage: "person.badge.key") { ProfileLogins.open(.codex, for: profile) }
        }
        Button("Show Folder", systemImage: "folder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: profile.home)]) }
        if !profile.isPersonal {
            Divider()
            Button("Remove…", systemImage: "trash", role: .destructive) { remove() }
                .disabled(current)
        }
    }
}

/// A profile's setup as it goes: its last line with a spinner, a team to
/// pick, or why it stopped with Try Again.
private struct JobView: View {
    let job: ProfileJobInfo
    let retry: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            switch job.state {
            case "running":
                HStack(spacing: zoomed(6)) {
                    ProgressView().controlSize(.small)
                    Text(job.lines.last ?? "Starting…").lineLimit(2)
                }
                Text("If your browser opened a Convex page, approve it there. This takes a few minutes.").foregroundStyle(.secondary)
            case "needs-team":
                Text(job.message ?? "Pick a Convex team.")
                HStack {
                    ForEach(job.teams ?? []) { team in
                        Button(team.name) { retry(team.slug) }
                    }
                }
            case "failed":
                Text(job.message ?? "Setup stopped.").foregroundStyle(.red).lineLimit(3)
                Button("Try Again") { retry(nil) }
            default:
                Label("Set up. Sign it in to Claude or Codex from ⋯, then switch to it.", systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.system(size: TypeScale.label))
        .padding(.leading, zoomed(18))
    }
}

private struct NewProfileSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var project = ""
    let create: (String, String) -> Void

    private var slug: String {
        name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(14)) {
            Text("New Profile").font(.system(size: zoomed(17), weight: .semibold))
            Text("Its own threads, logins and Convex backend, beside your others. Threadbear opens your browser to sign in to the Convex account for it (a work one, say), makes its backend there, and starts its runner. It takes a few minutes.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Form {
                TextField("Name", text: $name, prompt: Text("Work"))
                TextField("Convex project", text: $project, prompt: Text(slug.isEmpty ? "threadbear-work" : "threadbear-\(slug)"))
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Make Profile") {
                    create(name.trimmingCharacters(in: .whitespaces), project.trimmingCharacters(in: .whitespaces))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(zoomed(20))
        .frame(width: zoomed(440))
    }
}

/// Signing a profile's own Claude or Codex login in: a Terminal window
/// with the CLI pointed at the profile's folder (its logins/claude-main
/// or codex-main), never ~/.claude or ~/.codex.
@MainActor
enum ProfileLogins {
    enum CLI { case claude, codex }

    static func open(_ cli: CLI, for profile: ProfileInfo) {
        let dir = URL(fileURLWithPath: profile.home).appendingPathComponent(cli == .claude ? "logins/claude-main" : "logins/codex-main").path
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let quoted = "'" + dir.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = switch cli {
        case .claude: "export CLAUDE_CONFIG_DIR=\(quoted)\necho 'Signing in to Claude for the \(profile.name) profile. Type /login, sign in, then /exit.'\nclaude\n"
        case .codex: "export CODEX_HOME=\(quoted)\necho 'Signing in to Codex for the \(profile.name) profile.'\ncodex login\n"
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-\(profile.id)-\(cli == .claude ? "claude" : "codex")-login.command")
        do {
            try ("#!/bin/zsh -l\n" + script).write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch {
            AppLog.write("profiles", "couldn't open the sign-in: \(error.localizedDescription)")
        }
    }
}
