import CoreGraphics
import Foundation

/// Cuts one tall PDF page (a whole Page, captured by WebKit) into US Letter
/// pages with margins, scaled to fit the width, for Download as PDF. Pure
/// Core Graphics, so it's tested without a web view.
public enum PagePDF {
    /// The CSS width a page is laid out at for print: its cards and charts
    /// keep their desktop layout, and the text prints at a readable size.
    public static let layoutWidth: CGFloat = 800
    /// The longest page drawn, in CSS pixels (about 40 Letter pages).
    public static let maxHeight: CGFloat = 40_000
    public static let paper = CGSize(width: 612, height: 792)
    public static let margin: CGFloat = 36

    /// How many pages a source of this size cuts into.
    public static func pageCount(sourceWidth: CGFloat, sourceHeight: CGFloat) -> Int {
        let scale = (paper.width - margin * 2) / sourceWidth
        let perPage = (paper.height - margin * 2) / scale
        return max(1, Int(ceil(sourceHeight / perPage - 0.001)))
    }

    public static func paginate(_ data: Data) -> Data? {
        guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider), let page = doc.page(at: 1) else { return nil }
        let box = page.getBoxRect(.mediaBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let scale = (paper.width - margin * 2) / box.width
        let perPage = (paper.height - margin * 2) / scale
        let count = pageCount(sourceWidth: box.width, sourceHeight: box.height)
        let out = NSMutableData()
        var media = CGRect(origin: .zero, size: paper)
        guard let consumer = CGDataConsumer(data: out as CFMutableData), let ctx = CGContext(consumer: consumer, mediaBox: &media, nil) else { return nil }
        for i in 0..<count {
            ctx.beginPDFPage(nil)
            ctx.saveGState()
            ctx.clip(to: CGRect(x: margin, y: margin, width: paper.width - margin * 2, height: paper.height - margin * 2))
            // PDF space runs bottom up: slice i is the i-th band from the top.
            let top = box.height - CGFloat(i) * perPage
            ctx.translateBy(x: margin, y: paper.height - margin)
            ctx.scaleBy(x: scale, y: scale)
            ctx.translateBy(x: -box.minX, y: -(top + box.minY))
            ctx.drawPDFPage(page)
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
        return out as Data
    }
}
