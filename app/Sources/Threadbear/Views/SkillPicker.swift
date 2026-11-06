import AppKit
import SwiftUI
import ThreadbearCore

/// The composer's / list (ComposerTextView): the installed skills matching
/// what's typed after the slash, in a small window just over the cursor.
/// It never takes the keyboard: the text view passes it ↑↓, Return, Tab and
/// Esc, so typing carries on and nothing else in the app waits on it.
@MainActor
final class SkillPicker {
    private let pick: (String) -> Void
    private var window: NSPanel?
    private let model = Model()

    @Observable
    final class Model {
        var matches: [SkillMentions.Entry] = []
        var selected = 0
    }

    init(pick: @escaping (String) -> Void) { self.pick = pick }

    var isShown: Bool { window?.isVisible == true }
    var selected: String? { model.matches.indices.contains(model.selected) ? model.matches[model.selected].name : nil }

    /// Names starting with what's typed first, then ones containing it.
    static func matches(_ query: String, in skills: [SkillMentions.Entry]) -> [SkillMentions.Entry] {
        let q = query.lowercased()
        let sorted = skills.sorted { $0.name < $1.name }
        return Array((sorted.filter { $0.name.hasPrefix(q) } + sorted.filter { !$0.name.hasPrefix(q) && $0.name.contains(q) }).prefix(8))
    }

    func show(_ matches: [SkillMentions.Entry], above caret: NSRect, parent: NSWindow?) {
        let kept = selected
        model.matches = matches
        model.selected = kept.flatMap { name in matches.firstIndex { $0.name == name } } ?? 0
        let panel = window ?? makeWindow()
        let height = CGFloat(min(matches.count, 8)) * 44 + 12
        let width: CGFloat = 340
        panel.setFrame(NSRect(x: caret.minX - 8, y: caret.maxY + 6, width: width, height: height), display: true)
        if let parent, panel.parent !== parent { parent.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)
    }

    func move(_ by: Int) {
        guard !model.matches.isEmpty else { return }
        model.selected = (model.selected + by + model.matches.count) % model.matches.count
    }

    func hide() {
        guard let window, window.isVisible else { return }
        window.parent?.removeChildWindow(window)
        window.orderOut(nil)
    }

    private func makeWindow() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.hasShadow = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.contentView = NSHostingView(rootView: SkillPickerList(model: model) { [weak self] name in self?.pick(name) })
        window = panel
        return panel
    }
}

private struct SkillPickerList: View {
    let model: SkillPicker.Model
    let pick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(model.matches.enumerated()), id: \.element.name) { index, skill in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "sparkles.rectangle.stack")
                        .foregroundStyle(index == model.selected ? Color.white : Color.accentColor)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("/" + skill.name)
                            .font(.system(.body, design: .monospaced).weight(.semibold))
                        Text(skill.description)
                            .font(.caption)
                            .lineLimit(1)
                            .opacity(0.8)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(index == model.selected ? Color.white : Color.primary)
                .padding(.horizontal, 10)
                .frame(height: 44)
                .background(RoundedRectangle(cornerRadius: 6).fill(index == model.selected ? Color.accentColor : .clear))
                .contentShape(Rectangle())
                .onTapGesture { pick(skill.name) }
                .tip("Use the \(skill.name) skill")
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 10).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.1)))
    }
}
