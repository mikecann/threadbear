import AppKit
import ThreadbearCore

/// The Skills page's side of AppModel (docs/protocol.md, "Skills"). The
/// runner owns the store; this lists it and sends changes.
extension AppModel {
    /// After hello; `skills.updated` replaces the list from then on.
    func loadSkills() {
        guard let client else { return }
        Task {
            do {
                let result = try await client.skills()
                suggestedSkills = result.suggested ?? []
                receive(skills: result.skills, enabled: result.enabled)
                // A runner from before Instructions just leaves the box empty.
                if let text = try? await client.standingInstructions() { standingInstructions = text }
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                // A runner from before Skills: no button.
                skillsSupported = false
            } catch {
                AppLog.write("rpc", "skills.list failed: \(error.localizedDescription)")
            }
        }
    }

    func receive(skills list: [Skill], enabled: Bool? = nil) {
        skills = list
        skillsSupported = true
        if let enabled { skillsEnabled = enabled }
        // Their slash commands show as links where they'd run (SkillMentions).
        SkillMentions.names = skillsEnabled ? Set(list.map(\.name)) : []
        // What's suggested goes as it's added.
        let names = Set(list.map(\.name))
        suggestedSkills.removeAll { names.contains($0.name) }
    }

    /// Settings, Skills and Notes, the pages over the main panel, put away.
    func closeOverlayPages() {
        showsSettingsPage = false
        showsSkillsPage = false
        showsNotesPage = false
    }

    /// The Notes page over the main panel.
    func showNotes() {
        showsSettingsPage = false
        showsSkillsPage = false
        showsNotesPage = true
    }

    /// The Skills page over the main panel, as Settings is: what's open stays under it.
    func showSkills() {
        showsSettingsPage = false
        showsNotesPage = false
        showsSkillsPage = true
        loadSkills()
    }

    /// Imports a GitHub link or a page naming a skill. Nil when it worked,
    /// else what to say under the field.
    func importSkill(_ link: String) async -> String? {
        await skillChange("Importing…") { try await $0.addSkill(url: link.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    /// Saves a skill written on the Skills page. Nil when it worked, else
    /// what to say under the form.
    func saveSkill(name: String, text: String, description: String, replacing: String?) async -> String? {
        await skillChange("Saving…") { try await $0.saveSkill(name: name, text: text, description: description, replacing: replacing) }
    }

    /// Saves his standing instructions. Nil when it worked, else why not.
    func saveStandingInstructions(_ text: String) async -> String? {
        guard let client, connection == .connected else { return "Not connected to the runner." }
        do {
            standingInstructions = try await client.standingInstructions(set: text)
            return nil
        } catch RPCError.server(_, let message) {
            return message
        } catch {
            return error.localizedDescription
        }
    }

    /// The SKILL.md of one of his own, for Edit.
    func skillText(_ name: String) async -> String? {
        guard let client else { return nil }
        return try? await client.skillText(name: name)
    }

    func addSuggestedSkill(_ id: String) async -> String? {
        await skillChange("Adding \(id)…") { try await $0.addSkill(suggested: id) }
    }

    func setSkill(_ name: String, always: Bool) {
        // Shown straight away; the runner's answer has the last word.
        if let i = skills.firstIndex(where: { $0.name == name }) { skills[i].always = always }
        Task { if let error = await skillChange(nil, { try await $0.updateSkill(name: name, always: always) }) { errorMessage = error } }
    }

    func updateSkill(_ name: String) {
        Task { if let error = await skillChange("Updating \(name)…", { try await $0.updateSkill(name: name, latest: true) }) { errorMessage = error } }
    }

    /// Settings > General's switch for the whole store.
    func setSkillsEnabled(_ on: Bool) {
        skillsEnabled = on
        if !on { showsSkillsPage = false }
        Task { if let error = await skillChange(nil, { try await $0.enableSkills(on) }) { errorMessage = error } }
    }

    func removeSkill(_ name: String) {
        Task { if let error = await skillChange(nil, { try await $0.removeSkill(name: name) }) { errorMessage = error } }
    }

    private func skillChange(_ busy: String?, _ call: (RPCClient) async throws -> SkillsResult) async -> String? {
        guard let client, connection == .connected else { return "Not connected to the runner." }
        skillsBusy = busy
        defer { skillsBusy = nil }
        do {
            let result = try await call(client)
            receive(skills: result.skills, enabled: result.enabled)
            if let suggested = result.suggested { suggestedSkills = suggested }
            return nil
        } catch RPCError.server(_, let message) {
            return message
        } catch {
            return error.localizedDescription
        }
    }
}
