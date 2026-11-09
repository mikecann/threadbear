import AppKit
import SwiftUI
import ThreadbearCore

/// A home page laid out as the user set it (the Librarian's, the Scheduled
/// page's): its parts in a scrolling column over an optional background
/// photo, Customize at the top right, and the page's Customize panel
/// sliding in beside it so each change shows as it's made. The page says
/// what its parts and panel are; this is the frame they share.
struct CustomizedPage<Blocks: View, Buttons: View, Editor: View>: View {
    let backdrop: NSImage?
    let dim: Double
    let focus: BackdropFocus
    let slot: BackdropSlot
    /// Every part is hidden: the page says how to get them back.
    let isEmpty: Bool
    /// What Customize's tooltip says it changes.
    let customizeTip: String
    @ViewBuilder let blocks: () -> Blocks
    /// Buttons before Customize at the top right (View profile page).
    @ViewBuilder let buttons: () -> Buttons
    /// The panel, handed what closes it.
    @ViewBuilder let editor: (_ done: @escaping () -> Void) -> Editor
    @State private var editing = false

    var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: zoomed(32)) {
                    blocks()
                    if isEmpty {
                        Text("Everything on this page is hidden. Customize puts it back.")
                            .font(.system(size: TypeScale.label))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: zoomed(1000), alignment: .leading)
                .padding(.horizontal, zoomed(32))
                .padding(.top, zoomed(28))
                .padding(.bottom, zoomed(48))
                .frame(maxWidth: .infinity)
            }
            .background {
                if let backdrop { BackdropPicture(image: backdrop, dim: dim, focus: focus, slot: slot) }
            }
            .environment(\.onPicture, backdrop != nil)
            .overlay(alignment: .topTrailing) {
                HStack(spacing: zoomed(8)) {
                    buttons()
                    if !editing {
                        Button { withAnimation(.easeOut(duration: 0.18)) { editing = true } } label: {
                            Label("Customize", systemImage: "paintbrush")
                        }
                        .controlSize(.small)
                        .tip(customizeTip)
                    }
                }
                .padding(zoomed(14))
            }
            if editing {
                Divider()
                editor { withAnimation(.easeOut(duration: 0.18)) { editing = false } }
                    .frame(width: zoomed(320))
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
    }
}

/// A customized page's numbers: the tiles left after the hidden ones,
/// three across at most, or nothing when they're all hidden.
struct LookNumbers: View {
    let stats: [HomeStat]
    let hidden: Set<String>

    var body: some View {
        let shown = stats.filter { !hidden.contains($0.key) }
        if !shown.isEmpty {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: zoomed(170)), spacing: zoomed(14), alignment: .top)],
                alignment: .leading,
                spacing: zoomed(14)
            ) {
                ForEach(shown) { HomeStatTile(stat: $0) }
            }
            .frame(maxWidth: zoomed(620), alignment: .leading)
        }
    }
}
