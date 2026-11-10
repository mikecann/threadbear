import AppKit
import SwiftUI
import ThreadbearCore

/// The Projects page's Customize panel, beside the page so every change
/// shows as it's made: a picture of your own (the page has no bear), a
/// background photo, where each part sits and whether it shows, and what
/// each card shows. Picture and Background are the other panels' own
/// sections (LookEditorSections).
struct ProjectsLookEditor: View {
    @Binding var look: ProjectsLook
    let done: () -> Void

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
                LookPictureSection(look: $look, bearTip: "", pictures: ProjectsLook.pictures, removed: .none)
                LookBackgroundSection(look: $look, slot: .projects)
                layoutSection
                cardsSection
                Section {
                    Button("Reset to the standard page") { look = .standard }
                        .disabled(look.isStandard)
                        .tip("Put the layout and every card part back as Threadbear ships them, and take away your pictures")
                }
            }
            .formStyle(PanelFormStyle())
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var layoutSection: some View {
        Section("Layout") {
            ForEach(ProjectsLook.Block.allCases) { block in
                // Name, switch and place in columns, as in the other panels.
                HStack(spacing: zoomed(10)) {
                    Text(block.title)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Toggle(block.title, isOn: Binding(get: { !look.hidden.contains(block) }, set: { look.setShown($0, for: block) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .tip(toggleTip(block))
                    Picker(block.title, selection: Binding(get: { look.place(block) }, set: { look.setPlace($0, for: block) })) {
                        ForEach(ProjectsLook.Place.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .frame(width: zoomed(92), alignment: .trailing)
                    .disabled(look.hidden.contains(block))
                    .tip("Top, middle or bottom of the page")
                }
            }
        }
    }

    private func toggleTip(_ block: ProjectsLook.Block) -> String {
        switch block {
        case .picture: "Show or hide your picture. Choose one under Picture first"
        case .header: "Show or hide the title, search and New project. Hidden, the cards show every project"
        case .cards: "Show or hide the project cards"
        }
    }

    private var cardsSection: some View {
        Section("Cards") {
            ForEach(ProjectsLook.CardPart.allCases) { part in
                Toggle(part.title, isOn: Binding(get: { look.shows(part) }, set: { look.setShown($0, for: part) }))
                    .disabled(look.hidden.contains(.cards))
                    .tip(cardTip(part))
            }
        }
    }

    private func cardTip(_ part: ProjectsLook.CardPart) -> String {
        switch part {
        case .art: "The wide tile with the project's icon. Off, cards are just text"
        case .threads: "How many open threads each project has"
        case .status: "What its threads are doing, or when it was last active"
        case .state: "The first lines of where the project is up to"
        }
    }
}
