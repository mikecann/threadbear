import SwiftUI

/// A Form drawn as plain cards in a scroll view: each Section's header,
/// then its rows in a rounded card with a line between them, as the grouped
/// style looks. For the Librarian's Customize panel.
///
/// The grouped style's rows took clicks in other places than they were
/// drawn on Wayne's Mac once the panel grew long (8 Nov): None under
/// Picture did nothing, a link field's tooltip came up over it, and a click
/// there opened the profile page instead. Here every row is an ordinary
/// view in a VStack, so where a control is drawn is where it's clicked.
struct PanelFormStyle: FormStyle {
    func makeBody(configuration: Configuration) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(18)) {
                ForEach(sections: configuration.content) { section in
                    VStack(alignment: .leading, spacing: zoomed(8)) {
                        if !section.header.isEmpty {
                            section.header
                                .font(.system(size: TypeScale.label, weight: .semibold))
                                .padding(.horizontal, zoomed(4))
                        }
                        if !section.content.isEmpty {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(section.content) { row in
                                    row
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, zoomed(10))
                                        .padding(.vertical, zoomed(8))
                                    if row.id != section.content.last?.id {
                                        Divider().padding(.leading, zoomed(10))
                                    }
                                }
                            }
                            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: zoomed(8), style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
                        }
                        if !section.footer.isEmpty {
                            section.footer
                                .font(.system(size: TypeScale.label))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, zoomed(4))
                        }
                    }
                }
            }
            .padding(zoomed(14))
            .toggleStyle(PanelSwitchStyle())
            .labeledContentStyle(PanelLabeledStyle())
            .textFieldStyle(.roundedBorder)
        }
    }
}

/// A switch with its label on the left and the switch at the right edge,
/// as a grouped Form lays them out.
struct PanelSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: zoomed(8)) {
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
            Toggle("", isOn: configuration.$isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }
}

/// A label on the left and its control on the right.
struct PanelLabeledStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: zoomed(10)) {
            configuration.label
            Spacer(minLength: zoomed(8))
            configuration.content
        }
    }
}
