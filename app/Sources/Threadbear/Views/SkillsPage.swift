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
    /// The New Skill (or Edit) form, while it's open.
    @State private var draft: SkillDraft?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Skills")
                    .font(.system(size: zoomed(17), weight: .semibold))
                Spacer()
                Button {
                    draft = SkillDraft()
                } label: {
                    Label("New Skill", systemImage: "plus")
                }
                .disabled(draft != nil)
                .tip("Write a skill of your own, with its own slash command")
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
                    InstructionsBox()
                    if let binding = Binding($draft) {
                        SkillForm(draft: binding) { draft = nil }
                    }
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
                        SkillRow(skill: skill) { name in
                            Task {
                                let text = await app.skillText(name) ?? ""
                                draft = SkillDraft(name: name, text: text, replacing: name)
                            }
                        }
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
    /// Edit, for one he wrote here.
    var onEdit: (String) -> Void = { _ in }

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
                if skill.isCustom {
                    Button("Edit", systemImage: "pencil") { onEdit(skill.name) }
                } else {
                    Button("Update to the Latest", systemImage: "arrow.down.circle") { app.updateSkill(skill.name) }
                }
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

/// What the New Skill form holds: a new skill, or (with `replacing`) one
/// of his own being edited.
struct SkillDraft {
    var name = ""
    var description = ""
    var text = ""
    var replacing: String?
}

/// New Skill: the slash command's name, when agents should use it, and
/// the skill's text (plain instructions, or a whole SKILL.md pasted in).
/// Save, Return in a field or ⌘Return saves it; it then works like any
/// other skill, in every thread, on every login.
private struct SkillForm: View {
    @Environment(AppModel.self) private var app
    @Binding var draft: SkillDraft
    let close: () -> Void
    @State private var saving = false
    @State private var error: String?
    @FocusState private var nameFocused: Bool

    private var slug: String {
        draft.name.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "^/", with: "", options: .regularExpression)
            .lowercased().replacingOccurrences(of: #"[^a-z0-9-]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    private var canSave: Bool { !slug.isEmpty && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !saving }

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(10)) {
            Text(draft.replacing == nil ? "New skill" : "Edit \(draft.replacing!)").font(.headline)
            HStack(spacing: zoomed(4)) {
                Text("/").font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
                TextField("name, like brand-voice", text: $draft.name)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .focused($nameFocused)
                    .onSubmit(save)
                    .tip("Its slash command: type /\(slug.isEmpty ? "name" : slug) in a message to use it")
            }
            if draft.replacing == nil {
                TextField("When should agents use it? (optional: its first line is used otherwise)", text: $draft.description)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(save)
                    .tip("What it's for, so agents pick it up by themselves when Always on")
            }
            TextEditor(text: $draft.text)
                .font(.system(size: zoomed(12), design: .monospaced))
                .scrollContentBackground(.hidden)
                .padding(zoomed(6))
                .frame(minHeight: zoomed(180), maxHeight: zoomed(320))
                .background(RoundedRectangle(cornerRadius: zoomed(6)).fill(Color.primary.opacity(0.04)))
                .overlay(alignment: .topLeading) {
                    if draft.text.isEmpty {
                        Text("Paste the skill's text here: what the agent should do, or a whole SKILL.md")
                            .font(.system(size: zoomed(12), design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .padding(zoomed(11))
                            .allowsHitTesting(false)
                    }
                }
                .tip("The skill's instructions. A pasted SKILL.md keeps its own header")
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if !slug.isEmpty, slug != draft.name.trimmingCharacters(in: .whitespaces).lowercased() {
                    Text("Saved as /\(slug)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel", action: close)
                    .keyboardShortcut(.cancelAction)
                    .tip("Close without saving")
                Button("Save", action: save)
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                    .tip("Save it (⌘Return)")
            }
        }
        .padding(zoomed(14))
        .background(RoundedRectangle(cornerRadius: zoomed(10)).strokeBorder(Color.accentColor.opacity(0.5)))
        .onAppear { if draft.replacing == nil { nameFocused = true } }
    }

    private func save() {
        guard canSave else { return }
        saving = true
        error = nil
        let d = draft
        Task {
            let failed = await app.saveSkill(name: slug, text: d.text, description: d.description, replacing: d.replacing)
            saving = false
            if let failed { error = failed } else { close() }
        }
    }
}

/// Instructions: what every thread's agent should always keep in mind
/// (who he is, how to write, what he works with), given to every session
/// on every login, Claude and Codex (docs/protocol.md, "skills.instructions").
/// Folded away until he opens it; empty is fine. Saved a moment after he
/// stops typing, and when it's folded or the page closes.
private struct InstructionsBox: View {
    @Environment(AppModel.self) private var app
    @State private var open = false
    @State private var text = ""
    @State private var loaded = false
    @State private var status: String?
    @State private var save: Task<Void, Never>?
    @FocusState private var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
                if open {
                    // Ready to type straight away.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { typing = true }
                } else {
                    commit()
                }
            } label: {
                HStack(spacing: zoomed(6)) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: zoomed(10), weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .foregroundStyle(.secondary)
                    Text("Instructions").font(.headline)
                    if !open {
                        Text(summary)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .tip(open ? "Fold the instructions away" : "What every thread's agent should always keep in mind")
            if open {
                Text("Threadbear gives these to every thread's agent in every session, on every login, Claude and Codex alike. A chat that's already going hears a change before your next message. Leave it empty for none.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(zoomed(6))
                    .frame(minHeight: zoomed(120), maxHeight: zoomed(300))
                    .background(RoundedRectangle(cornerRadius: zoomed(8)).fill(Color.primary.opacity(0.04)))
                    .overlay(RoundedRectangle(cornerRadius: zoomed(8)).strokeBorder(Color.accentColor.opacity(0.35)))
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text("For example: You're a senior full-stack developer and marketer. Write plainly and briefly. I build with React, TypeScript and Convex.")
                                .foregroundStyle(.tertiary)
                                .padding(zoomed(11))
                                .allowsHitTesting(false)
                        }
                    }
                    .focused($typing)
                    .onChange(of: text) { _, _ in scheduleSave() }
                    .tip("Your standing instructions for every agent")
                if let status {
                    Text(status).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .onAppear {
            if !loaded { text = app.standingInstructions; loaded = true }
        }
        .onChange(of: app.standingInstructions) { _, new in
            // Set elsewhere (or loaded late) while he isn't typing here.
            if save == nil, new.trimmingCharacters(in: .whitespacesAndNewlines) != text.trimmingCharacters(in: .whitespacesAndNewlines) { text = new }
        }
        .onDisappear { commit() }
    }

    private var summary: String {
        let first = app.standingInstructions.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return first.map(String.init) ?? "None set"
    }

    private func scheduleSave() {
        guard loaded else { return }
        save?.cancel()
        status = nil
        save = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await write()
        }
    }

    private func commit() {
        guard loaded, save != nil else { return }
        save?.cancel()
        Task { await write() }
    }

    private func write() async {
        save = nil
        let wanted = text
        guard wanted.trimmingCharacters(in: .whitespacesAndNewlines) != app.standingInstructions.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        if let error = await app.saveStandingInstructions(wanted) { status = error } else { status = wanted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Cleared" : "Saved" }
    }
}
