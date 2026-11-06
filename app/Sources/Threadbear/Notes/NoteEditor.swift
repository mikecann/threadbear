import AppKit
import SwiftUI
import ThreadbearCore

/// The notes editor: a code editor's plain text box, as in Sublime Text,
/// with line numbers down the left in a monospaced face, and basic
/// Markdown coloured as you type (NoteHighlight): headings, bold, italics,
/// code, list marks, links and quotes, with the marks themselves dimmed.
struct NoteEditor: NSViewRepresentable {
    let noteId: String
    let text: String
    let onChange: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        // Nothing of the gutter's drawn outside the editor (views don't clip by default).
        scroll.clipsToBounds = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        guard let view = scroll.documentView as? NSTextView else { return scroll }
        view.delegate = context.coordinator
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.smartInsertDeleteEnabled = false
        view.font = NoteStyle.font
        view.textColor = .labelColor
        view.drawsBackground = false
        view.insertionPointColor = .controlAccentColor
        view.textContainerInset = NSSize(width: 8, height: 12)
        view.typingAttributes = NoteStyle.base
        view.setAccessibilityLabel("Note")
        let ruler = LineNumberRuler(textView: view)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        context.coordinator.view = view
        context.coordinator.load(text, noteId: noteId)
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.onChange = onChange
        // Another note picked: its text, from the top.
        if context.coordinator.noteId != noteId { context.coordinator.load(text, noteId: noteId) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var onChange: (String) -> Void
        weak var view: NSTextView?
        var noteId: String?

        init(onChange: @escaping (String) -> Void) { self.onChange = onChange }

        func load(_ text: String, noteId: String) {
            self.noteId = noteId
            guard let view else { return }
            view.string = text
            NoteStyle.apply(to: view)
            view.setSelectedRange(NSRange(location: 0, length: 0))
            view.scrollToBeginningOfDocument(nil)
            view.enclosingScrollView?.verticalRulerView?.needsDisplay = true
        }

        func textDidChange(_ notification: Notification) {
            guard let view else { return }
            NoteStyle.apply(to: view)
            view.enclosingScrollView?.verticalRulerView?.needsDisplay = true
            onChange(view.string)
        }
    }
}

enum NoteStyle {
    static var font: NSFont { .monospacedSystemFont(ofSize: TypeScale.scaled(13), weight: .regular) }

    static var base: [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = 1.25
        return [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: style]
    }

    /// The colours, on the text as it is; the words never change.
    static func apply(to view: NSTextView) {
        guard let storage = view.textStorage else { return }
        let whole = NSRange(location: 0, length: storage.length)
        let selected = view.selectedRanges
        storage.beginEditing()
        storage.setAttributes(base, range: whole)
        let mono = font
        let bold = NSFontManager.shared.convert(mono, toHaveTrait: .boldFontMask)
        let italic = NSFontManager.shared.convert(mono, toHaveTrait: .italicFontMask)
        for span in NoteHighlight.spans(in: storage.string) where NSMaxRange(span.range) <= storage.length {
            switch span.kind {
            case .heading: storage.addAttributes([.font: bold, .foregroundColor: NSColor.controlAccentColor], range: span.range)
            case .bold: storage.addAttribute(.font, value: bold, range: span.range)
            case .italic: storage.addAttribute(.font, value: italic, range: span.range)
            case .code: storage.addAttributes([.foregroundColor: NSColor.systemPink, .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.15)], range: span.range)
            case .codeBlock: storage.addAttributes([.foregroundColor: NSColor.systemPink, .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.12)], range: span.range)
            case .listMarker: storage.addAttributes([.foregroundColor: NSColor.controlAccentColor, .font: bold], range: span.range)
            case .link: storage.addAttributes([.foregroundColor: NSColor.linkColor, .underlineStyle: NSUnderlineStyle.single.rawValue], range: span.range)
            case .quote: storage.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: span.range)
            case .mark: storage.addAttribute(.foregroundColor, value: NSColor.tertiaryLabelColor, range: span.range)
            }
        }
        storage.endEditing()
        view.selectedRanges = selected
        view.typingAttributes = base
    }
}

/// Line numbers down the editor's left side, one for each line of the
/// note (not each wrapped row), the current line's brighter.
final class LineNumberRuler: NSRulerView {
    private weak var textView: NSTextView?

    init(textView: NSTextView) {
        self.textView = textView
        super.init(scrollView: textView.enclosingScrollView, orientation: .verticalRuler)
        clientView = textView
        ruleThickness = 44
        clipsToBounds = true
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSView.boundsDidChangeNotification, object: textView.enclosingScrollView?.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(redraw), name: NSTextView.didChangeSelectionNotification, object: textView)
    }

    required init(coder: NSCoder) { fatalError() }

    @objc private func redraw() { needsDisplay = true }

    /// Only the numbers and a hairline on the gutter's own edge; the
    /// default border ran up past the editor.
    override func draw(_ dirtyRect: NSRect) {
        drawHashMarksAndLabels(in: dirtyRect)
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - 0.5, y: bounds.minY, width: 0.5, height: bounds.height).fill()
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView, let layout = textView.layoutManager, let container = textView.textContainer else { return }
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        let text = textView.string as NSString
        let font = NSFont.monospacedDigitSystemFont(ofSize: TypeScale.scaled(11), weight: .regular)
        let caret = text.lineRange(for: NSRange(location: min(textView.selectedRange().location, text.length), length: 0)).location
        let visible = textView.visibleRect
        let glyphs = layout.glyphRange(forBoundingRect: visible, in: container)
        let chars = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        // The line number of the first visible line.
        var number = 1
        text.enumerateSubstrings(in: NSRange(location: 0, length: chars.location), options: [.byLines, .substringNotRequired]) { _, _, _, _ in number += 1 }
        var index = chars.location
        let inset = textView.textContainerInset.height
        func draw(_ n: Int, at line: NSRange, y: CGFloat) {
            let current = line.location == caret
            let label = "\(n)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: current ? NSColor.secondaryLabelColor : NSColor.tertiaryLabelColor]
            let size = label.size(withAttributes: attributes)
            label.draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y), withAttributes: attributes)
        }
        while index <= NSMaxRange(chars) {
            let line = text.lineRange(for: NSRange(location: index, length: 0))
            let glyph = layout.glyphIndexForCharacter(at: min(line.location, max(text.length - 1, 0)))
            var lineRect = text.length == 0 ? NSRect(x: 0, y: 0, width: 0, height: font.boundingRectForFont.height + 4) : layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            lineRect.origin.y += inset
            let y = convert(NSPoint(x: 0, y: lineRect.minY), from: textView).y + 3
            draw(number, at: line, y: y)
            number += 1
            if NSMaxRange(line) <= index || NSMaxRange(line) >= text.length { break }
            index = NSMaxRange(line)
        }
        // The empty last line after a final newline gets its number too.
        if text.length > 0, text.hasSuffix("\n"), NSMaxRange(chars) >= text.length {
            let rect = layout.extraLineFragmentRect
            let y = convert(NSPoint(x: 0, y: rect.minY + inset), from: textView).y + 3
            draw(number, at: NSRange(location: text.length, length: 0), y: y)
        }
    }
}
