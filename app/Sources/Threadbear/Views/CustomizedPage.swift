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
    /// The places with at least one part showing. None: the page says how
    /// to get them back.
    let filled: Set<LibrarianLook.Place>
    /// True: top, middle and bottom are where the parts sit in the window
    /// (middle in the space between, bottom on the window's bottom edge),
    /// and a page too tall for the window just stacks them and scrolls.
    /// False: they're only the order the parts stack in, as the Librarian
    /// page has always had them.
    var pinsPlaces = false
    /// What Customize's tooltip says it changes.
    let customizeTip: String
    /// The parts in one place, top to bottom.
    @ViewBuilder let blocks: (LibrarianLook.Place) -> Blocks
    /// Buttons before Customize at the top right (View profile page).
    @ViewBuilder let buttons: () -> Buttons
    /// The panel, handed what closes it.
    @ViewBuilder let editor: (_ done: @escaping () -> Void) -> Editor
    @State private var editing = false

    var body: some View {
        HStack(spacing: 0) {
            GeometryReader { window in
                ScrollView {
                    column
                        .frame(maxWidth: zoomed(1000), alignment: .leading)
                        .padding(.horizontal, zoomed(32))
                        // Clear of the Customize button, which a wide part
                        // (the numbers) at the top would otherwise run under.
                        .padding(.top, zoomed(56))
                        .padding(.bottom, zoomed(48))
                        .frame(maxWidth: .infinity)
                        // At least the window's height, so the spacers have
                        // room to push middle and bottom down.
                        .frame(minHeight: pinsPlaces ? window.size.height : nil, alignment: .top)
                }
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

    @ViewBuilder
    private var column: some View {
        let gap = zoomed(32)
        if filled.isEmpty {
            Text("Everything on this page is hidden. Customize puts it back.")
                .font(.system(size: TypeScale.label))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if pinsPlaces {
            VStack(alignment: .leading, spacing: 0) {
                zone(.top)
                // The gap only between places that have something, so an
                // empty one leaves no hole when the page scrolls.
                Spacer(minLength: filled.contains(.top) && filled.count > 1 ? gap : 0)
                zone(.middle)
                Spacer(minLength: filled.contains(.middle) && filled.contains(.bottom) ? gap : 0)
                zone(.bottom)
            }
        } else {
            VStack(alignment: .leading, spacing: gap) {
                ForEach(LibrarianLook.Place.allCases) { place in
                    if filled.contains(place) { blocks(place) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func zone(_ place: LibrarianLook.Place) -> some View {
        if filled.contains(place) {
            VStack(alignment: .leading, spacing: zoomed(32)) { blocks(place) }
                .frame(maxWidth: .infinity, alignment: .leading)
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
