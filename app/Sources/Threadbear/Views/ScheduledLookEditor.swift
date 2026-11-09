import AppKit
import SwiftUI
import ThreadbearCore

/// The Scheduled page's Customize panel, beside the page so every change
/// shows as it's made: the picture, a background photo, where each part
/// sits and whether it shows, and which numbers show. The Picture and
/// Background sections are the Librarian panel's own (LookEditorSections).
struct ScheduledLookEditor: View {
    @Binding var look: ScheduledLook
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
                LookPictureSection(look: $look, bearTip: "Show the bear winding its alarm clock")
                LookBackgroundSection(look: $look, slot: .scheduled)
                layoutSection
                numbersSection
                Section {
                    Button("Reset to the standard page") { look = .standard }
                        .disabled(look.isStandard)
                        .tip("Put the bear, the layout and every part back as Threadbear ships them, and take away your pictures")
                }
            }
            .formStyle(PanelFormStyle())
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var layoutSection: some View {
        Section("Layout") {
            ForEach(ScheduledLook.Block.allCases) { block in
                // Name, switch and place in columns, as in the Librarian's panel.
                HStack(spacing: zoomed(10)) {
                    Text(block.title)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Toggle(block.title, isOn: Binding(get: { !look.hidden.contains(block) }, set: { look.setShown($0, for: block) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                        .tip("Show or hide \(block.title.lowercased()) on the page")
                    Picker(block.title, selection: Binding(get: { look.place(block) }, set: { look.setPlace($0, for: block) })) {
                        ForEach(ScheduledLook.Place.allCases) { Text($0.title).tag($0) }
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

    private var numbersSection: some View {
        Section("Numbers") {
            ForEach(ScheduledStats.names, id: \.key) { number in
                Toggle(number.title, isOn: Binding(
                    get: { !look.hiddenNumbers.contains(number.key) },
                    set: { if $0 { look.hiddenNumbers.remove(number.key) } else { look.hiddenNumbers.insert(number.key) } }
                ))
                .disabled(look.hidden.contains(.numbers))
                .tip("Show or hide \(number.title.lowercased())")
            }
        }
    }
}
