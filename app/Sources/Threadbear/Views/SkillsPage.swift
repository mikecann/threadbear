import AppKit
import SwiftUI
import ThreadbearCore

/// The Skills page (the bar's Skills, under the Librarian), over the main
/// panel as Settings is: Threadbear's skills, which every thread's agent
/// gets on every login, Claude and Codex (docs/protocol.md, "Skills"). Paste
/// a GitHub link to import one; Always on means agents use it whenever it
/// fits, off means only its slash command runs it.
struct SkillsPage: View {
    @Environment(AppModel.self) private var app
    @State private var link = ""
    @State private var importError: String?
    @State private var importing = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Skills")
                    .font(.system(size: zoomed(17), weight: .semibold))
                Spacer()
                Button {
                    app.showsSkillsPage = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: zoomed(12), weight: .semibold))
                        .frame(width: zoomed(28), height: zoomed(28))
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .tip("Close Skills (Esc)")
                .accessibilityLabel("Close Skills")
            }
            // Clear of the divider's resize grab (SettingsPage says why).
            .padding(.leading, zoomed(20))
            .padding(.trailing, zoomed(28))
            .padding(.vertical, zoomed(12))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: zoomed(22)) {
                    intro
                    importBox
                    installed
                    if !app.suggestedSkills.isEmpty { suggested }
                }
                .frame(maxWidth: zoomed(680), alignment: .leading)
                .padding(.horizontal, zoomed(28))
                .padding(.vertical, zoomed(20))
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onExitCommand { app.showsSkillsPage = false }
    }

    private var intro: some View {
        Text("Skills give every thread's agent extra know-how, on every login, Claude and Codex alike. With Always on, agents use a skill whenever it fits; with it off, only when you type its slash command, like /pele.")
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Import

    private var importBox: some View {
        VStack(alignment: .leading, spacing: zoomed(6)) {
            Text("Import a skill").font(.headline)
            HStack(spacing: zoomed(8)) {
                TextField("A GitHub link to a skill or a repo of skills, or a page that has one", text: $link)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(runImport)
                    .disabled(importing)
                    .tip("Paste github.com/owner/repo, a folder or a SKILL.md link, or a skill's own page")
                if importing {
                    ProgressView().controlSize(.small)
                }
                Button("Import", action: runImport)
                    .disabled(importing || link.trimmingCharacters(in: .whitespaces).isEmpty)
                    .tip("Fetch it from GitHub, pinned to its current commit")
            }
            if let importError {
                Label(importError, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let busy = app.skillsBusy {
                Text(busy).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func runImport() {
        let text = link
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty, !importing else { return }
        importing = true
        importError = nil
        Task {
            let error = await app.importSkill(text)
            importing = false
            importError = error
            if error == nil { link = "" }
        }
    }

    // MARK: Installed

    private var installed: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("Your skills").font(.headline)
            if app.skills.isEmpty {
                Text("None yet. Import one above, or add a suggested one below.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(app.skills.enumerated()), id: \.element.id) { index, skill in
                        if index > 0 { Divider().padding(.leading, zoomed(14)) }
                        SkillRow(skill: skill)
                    }
                }
                .background(RoundedRectangle(cornerRadius: zoomed(10)).fill(Color.primary.opacity(0.04)))
                Text("A change reaches each thread when its agent next starts.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: Suggested

    private var suggested: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("Suggested").font(.headline)
            ForEach(app.suggestedSkills) { skill in
                SuggestedRow(skill: skill)
            }
        }
    }
}

private struct SkillRow: View {
    @Environment(AppModel.self) private var app
    let skill: Skill

    var body: some View {
        HStack(alignment: .top, spacing: zoomed(12)) {
            VStack(alignment: .leading, spacing: zoomed(3)) {
                HStack(spacing: zoomed(6)) {
                    Text(skill.name).font(.body.weight(.semibold))
                    Text("/\(skill.name)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, zoomed(5))
                        .padding(.vertical, zoomed(1))
                        .background(Capsule().fill(Color.primary.opacity(0.07)))
                        .tip("Type /\(skill.name) in any thread to use it")
                }
                Text(skill.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .tip(skill.description)
                Text(skill.sourceLine)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: zoomed(8))
            Toggle("Always on", isOn: Binding(get: { skill.always }, set: { app.setSkill(skill.name, always: $0) }))
                .toggleStyle(.switch)
                .controlSize(.small)
                .tip(skill.always ? "Agents use it whenever it fits. Turn off to use it only with /\(skill.name)" : "Only /\(skill.name) uses it. Turn on to let agents use it whenever it fits")
            IconMenu {
                Button("Update to the Latest", systemImage: "arrow.down.circle") { app.updateSkill(skill.name) }
                if let url = skill.sourceURL {
                    Button("View on GitHub", systemImage: "safari") { NSWorkspace.shared.open(url) }
                }
                Button("Show in Finder", systemImage: "folder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: skill.dir).appendingPathComponent("SKILL.md")])
                }
                Divider()
                Button("Remove", systemImage: "trash", role: .destructive) { app.removeSkill(skill.name) }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: zoomed(22), height: zoomed(22))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .tip("More for \(skill.name)")
        }
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(10))
    }
}

private struct SuggestedRow: View {
    @Environment(AppModel.self) private var app
    let skill: SuggestedSkill
    @State private var adding = false
    @State private var error: String?

    var body: some View {
        HStack(alignment: .top, spacing: zoomed(12)) {
            VStack(alignment: .leading, spacing: zoomed(3)) {
                Text(skill.name).font(.body.weight(.semibold))
                Text(skill.description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .tip(skill.description)
                if let error {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            Spacer(minLength: zoomed(8))
            if adding { ProgressView().controlSize(.small) }
            Button("Add") {
                adding = true
                error = nil
                Task {
                    error = await app.addSuggestedSkill(skill.id)
                    adding = false
                }
            }
            .disabled(adding)
            .tip("Add \(skill.name) to your skills")
        }
        .padding(.horizontal, zoomed(14))
        .padding(.vertical, zoomed(10))
        .background(RoundedRectangle(cornerRadius: zoomed(10)).strokeBorder(Color.primary.opacity(0.08)))
    }
}
