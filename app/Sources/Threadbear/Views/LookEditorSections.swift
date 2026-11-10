import AppKit
import SwiftUI
import ThreadbearCore
import UniformTypeIdentifiers

/// The Picture section of a page's Customize panel (the Librarian's, the
/// Scheduled and Projects pages'): the bear, a picture of your own or
/// none, and its size. A page with no bear of its own (Projects) offers
/// only your picture or none. Works on any PictureLook, so a page that becomes customizable
/// gets the same picture handling, file copies and fixes as the rest.
struct LookPictureSection<Look: PictureLook>: View {
    @Binding var look: Look
    /// What the bear option's tooltip says, as each page has its own bear.
    let bearTip: String
    /// The choices, in the order they show.
    var pictures: [LibrarianLook.Picture] = LibrarianLook.Picture.allCases
    /// What Remove goes back to: the bear, or none where there isn't one.
    var removed: LibrarianLook.Picture = .bear
    @State private var problem: String?

    var body: some View {
        Section("Picture") {
            SegmentedChoice(options: pictures, selection: look.picture, title: \.title, tip: tip) { pick($0) }
            if look.picture == .own {
                PictureWell(image: Looks.image(look.pictureFile), empty: "Drop a picture here") { url in
                    importPicture(url)
                }
                HStack {
                    Button(look.pictureFile == nil ? "Choose…" : "Replace…") {
                        Looks.choosePicture(prompt: "Use Picture") { importPicture($0) }
                    }
                    .tip("Pick a picture from your Mac. A copy is kept, so the original can move")
                    if look.pictureFile != nil {
                        Button("Remove") {
                            var next = look
                            next.pictureFile = nil
                            next.picture = removed
                            look = next
                        }
                        .tip(removed == .bear ? "Go back to the bear and delete the copy" : "Take the picture off the page and delete the copy")
                    }
                }
                .controlSize(.small)
            }
            if look.picture != .none {
                LabeledContent("Size") {
                    Picker("Size", selection: $look.pictureSize) {
                        ForEach(LibrarianLook.PictureSize.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                .tip("How big the picture is on the page")
            }
            if let problem {
                Text(problem)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.red)
            }
        }
    }

    private func tip(_ picture: LibrarianLook.Picture) -> String {
        switch picture {
        case .bear: bearTip
        case .own: "Show a picture of your own"
        case .none: "No picture on the page"
        }
    }

    private func pick(_ picture: LibrarianLook.Picture) {
        // Your picture with none chosen yet asks for one straight away.
        if picture == .own, look.pictureFile == nil {
            Looks.choosePicture(prompt: "Use Picture") { importPicture($0) }
            return
        }
        look.picture = picture
    }

    private func importPicture(_ url: URL) {
        guard let name = Looks.importPicture(from: url, maxSide: 1200, prefix: "picture") else {
            problem = "That file isn't a picture Threadbear can read."
            return
        }
        problem = nil
        // One change, so the new file and the choice land together.
        var next = look
        next.pictureFile = name
        next.picture = .own
        next.showPicture()
        look = next
    }
}

/// The Background section of a page's Customize panel: a photo behind the
/// page, where it sits when cropped, and how faded it is.
struct LookBackgroundSection<Look: PictureLook>: View {
    @Binding var look: Look
    /// Where the page draws it, so Position previews the same shape.
    let slot: BackdropSlot
    @State private var problem: String?

    var body: some View {
        Section("Background") {
            PictureWell(image: Looks.image(look.background), empty: "Drop a photo here", fill: true) { url in
                importBackground(url)
            }
            HStack {
                Button(look.background == nil ? "Choose…" : "Replace…") {
                    Looks.choosePicture(prompt: "Use as Background") { importBackground($0) }
                }
                .tip("Pick a photo to fill the page behind everything")
                if look.background != nil {
                    Button("Remove") { look.background = nil }
                        .tip("Take the background away and delete the copy")
                }
            }
            .controlSize(.small)
            if let image = Looks.image(look.background) {
                LabeledContent("Position") {
                    BackdropPositioner(image: image, slot: slot, focus: $look.backgroundFocus, maxWidth: zoomed(200), maxHeight: zoomed(130))
                }
                LabeledContent("Fade") {
                    Slider(value: $look.backgroundDim, in: 0...0.9)
                        .tip("How much the page's own colour covers the photo, so text stays easy to read in light and dark")
                }
            }
            if let problem {
                Text(problem)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.red)
            }
        }
    }

    private func importBackground(_ url: URL) {
        guard let name = Looks.importPicture(from: url, maxSide: 2880, prefix: "background") else {
            problem = "That file isn't a picture Threadbear can read."
            return
        }
        problem = nil
        // One change, and a new photo starts on the bottom edge, not where
        // the last one was.
        var next = look
        next.background = name
        next.backgroundFocus = .bottom
        look = next
    }
}

/// A picture's spot in the editor: the picture, or a dashed box to drop one
/// on. A dropped file is handed over to be copied in.
struct PictureWell: View {
    let image: NSImage?
    let empty: String
    var fill = false
    let dropped: (URL) -> Void
    @State private var targeted = false

    var body: some View {
        ZStack {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: fill ? .fill : .fit)
                    .frame(maxWidth: .infinity, maxHeight: zoomed(120))
                    .clipShape(RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
                    // Clipping only hides a filled photo's overflow; it still
                    // takes clicks. A tall photo's hidden top reached up over
                    // Picture and swallowed every click there (8 Nov), so the
                    // well takes clicks only inside its own box.
                    .contentShape(RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
            } else {
                Text(empty)
                    .font(.system(size: TypeScale.label))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: zoomed(64))
            }
        }
        .frame(maxWidth: .infinity)
        .overlay {
            RoundedRectangle(cornerRadius: zoomed(8), style: .continuous)
                .strokeBorder(targeted ? Color.accentColor : Color.primary.opacity(image == nil ? 0.2 : 0),
                              style: StrokeStyle(lineWidth: targeted ? 2 : 1, dash: image == nil && !targeted ? [4, 3] : []))
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $targeted) { providers in
            Looks.loadDropped(providers) { dropped($0) }
        }
        .tip("Drop a picture here from Finder, Photos or a browser")
    }
}

/// A row of choices drawn as one segmented control, out of plain SwiftUI
/// buttons. The AppKit segmented Picker in this panel took clicks without
/// changing anything on Wayne's Mac (8 Nov), and a control that runs its own
/// mouse loop can't be pressed by the automation either; these are ordinary
/// buttons, so a click always lands and an agent can press one by its tip.
struct SegmentedChoice<Option: Hashable & Identifiable>: View {
    let options: [Option]
    let selection: Option
    let title: KeyPath<Option, String>
    let tip: (Option) -> String
    let choose: (Option) -> Void

    var body: some View {
        HStack(spacing: zoomed(2)) {
            ForEach(options) { option in
                let on = option == selection
                Button { if !on { choose(option) } } label: {
                    Text(option[keyPath: title])
                        .font(.system(size: TypeScale.label, weight: on ? .medium : .regular))
                        .lineLimit(1)
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, zoomed(4))
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: zoomed(6), style: .continuous)
                                    .fill(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .tip(tip(option))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(zoomed(2))
        .background(Color.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: zoomed(8), style: .continuous))
        .animation(.easeOut(duration: 0.12), value: selection)
    }
}
