import CryptoKit
import Foundation

/// A fenced block in an agent's reply that's drawn as what it shows rather
/// than as code: ```mermaid as a diagram (with Pele, pele.run) and ```html
/// as a page, in a box with a Diagram / Source switch (Mike picked that
/// look on 6 Nov, from Ayush's bearfooding notes). The pure parts live
/// here so they're tested without AppKit: which fences count, each block's
/// id, the colours, and the pages the app's web views are given.
public struct RichBlock: Hashable, Sendable {
    /// `page` is the top of a Page's own file, drawn for its card in a
    /// reply (PageFence); it never comes from a fence itself.
    public enum Kind: String, Sendable { case mermaid, html, page }

    public let kind: Kind
    public let source: String
    /// Stable for the same kind and source, so a render, a toggle and a
    /// file for the side pane are found again after a restart.
    public let id: String

    public init(kind: Kind, source: String) {
        self.kind = kind
        self.source = source
        let digest = SHA256.hash(data: Data((kind.rawValue + "\n" + source).utf8))
        id = digest.prefix(10).map { String(format: "%02x", $0) }.joined()
    }

    /// Past this a block stays plain code: Pele refuses more than 50,000
    /// characters itself, and a page that size is a file, not a reply.
    public static let maxSource = 50_000

    /// The block for a fence's info string (```mermaid, ```HTML title=x:
    /// only the first word counts), or nil for anything else.
    public static func from(language: String?, code: String) -> RichBlock? {
        guard let word = language?.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "{" }).first?.lowercased() else { return nil }
        let kind: Kind
        switch word {
        case "mermaid": kind = .mermaid
        case "html": kind = .html
        default: return nil
        }
        var source = code
        while source.hasSuffix("\n") { source.removeLast() }
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, source.count <= maxSource else { return nil }
        return RichBlock(kind: kind, source: source)
    }

    /// What the box's header calls it.
    public var label: String { kind.rawValue }
    /// A Page's newest file drawn for its card: the version is in the
    /// source, so a new version is a new drawing.
    public static func pageThumb(file: String, version: Int, nativeDiagram: Bool = false) -> RichBlock {
        RichBlock(kind: .page, source: "\(file)\n\(version)\ncard 4\(nativeDiagram ? "\ndiagram" : "")")
    }

    /// The file a `page` block draws.
    public var pageFile: String? { kind == .page ? source.split(separator: "\n").first.map(String.init) : nil }

    /// The left half of the switch.
    public var drawnTitle: String { kind == .mermaid ? "Diagram" : "Preview" }
}

/// Pele's colours for Threadbear, matching the transcript's code box
/// (Theme.codeBackground over the window) so a diagram sits in it as if
/// drawn there. `bg` is only what labels are backed with; the rest of the
/// picture is see-through.
public struct RichPalette: Sendable, Equatable {
    public let bg, fg, muted, line, surface, surfaceAlt, border, accent: String

    public static let dark = RichPalette(bg: "#282828", fg: "#ececec", muted: "#9a9a9a", line: "#8e8e93",
                                         surface: "#333335", surfaceAlt: "#3a3a3c", border: "#5a5a5e", accent: "#0a84ff")
    public static let light = RichPalette(bg: "#f7f7f7", fg: "#1d1d1f", muted: "#6e6e73", line: "#86868b",
                                          surface: "#ffffff", surfaceAlt: "#f0f0f2", border: "#c7c7cc", accent: "#007aff")

    /// Pele's CSS variables (pele.run/theming).
    public var css: String {
        """
        .pele{--pele-bg:\(bg);--pele-fg:\(fg);--pele-muted:\(muted);--pele-line:\(line);--pele-surface:\(surface);\
        --pele-surface-alt:\(surfaceAlt);--pele-border:\(border);--pele-accent:\(accent);--pele-radius:6px;\
        --pele-font:-apple-system,system-ui,sans-serif;--pele-font-mono:ui-monospace,Menlo,monospace}
        """
    }
}

/// The pages the app's sandboxed web views are given.
public enum RichPages {
    /// Every rich web view's page gets this as its Content-Security-Policy:
    /// nothing from anywhere, except inline styles and pictures written
    /// into the page itself. The rule list and the dead proxy stop the
    /// network as well; this is the page's own say on top.
    public static let policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'"

    private static func escapeAttribute(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }

    /// The agent's HTML, with the policy in front of it. A `<meta>` policy
    /// only counts in the head before anything it governs, so it goes
    /// first (after a doctype), ahead of the agent's own head; browsers take
    /// what follows as the same document.
    public static func htmlPage(_ source: String) -> String {
        // The doctype first, or the page lays out in quirks mode; one of
        // the agent's own further on is ignored.
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"\(escapeAttribute(policy))\">"
            + "<meta name=\"color-scheme\" content=\"light dark\">"
            + source
    }

    /// The page the diagram view loads once, with Pele and both palettes;
    /// `drawScript` (with `source`, `dark` and `fontSize`) renders into it (the app passes the
    /// source as a JSON string, never as markup). The SVG Pele makes has
    /// no scripts or handlers in it (pele.run/security), links and
    /// pictures are turned off, and its error messages go in as text.
    public static var diagramPage: String {
        """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(escapeAttribute(policy))">
        <style>
        html,body{margin:0;padding:0;background:transparent}
        #out{display:inline-block;padding:2px}
        #out.dark{\(RichPalette.dark.css.replacingOccurrences(of: ".pele{", with: "").dropLast())}
        #out.light{\(RichPalette.light.css.replacingOccurrences(of: ".pele{", with: "").dropLast())}
        </style></head><body><div id="out"></div></body></html>
        """
    }

    /// The biggest a diagram is drawn, in CSS pixels: a side, and an area.
    public static let diagramMaxSide = 2400
    public static let diagramMaxArea = 2400 * 1600

    /// Run in the diagram page: renders `source` and gives back its size,
    /// or `{error}` with Pele's message. Its arguments: `source`, `dark`,
    /// `fontSize`, `maxSide` and `maxArea`.
    public static let drawScript = """
    const out = document.getElementById('out');
    out.className = dark ? 'dark' : 'light';
    try {
      const result = pele.render(source, { links: false, images: false, responsive: false, fontSize: fontSize,
        fontFamily: '-apple-system, system-ui, sans-serif', idPrefix: dark ? 'dk' : 'lt' });
      out.innerHTML = result.svg;
      // The box round the SVG and all it draws (a few shapes reach past
      // its viewBox), so the snapshot takes all of it.
      const svg = out.querySelector('svg');
      // A diagram can ask for any size (spacing in its config): drawn
      // smaller past a budget, so a hostile one can't make a picture of
      // gigabytes (cross-lab review, 6 Nov).
      const w = parseFloat(svg.getAttribute('width')) || 1;
      const h = parseFloat(svg.getAttribute('height')) || 1;
      const scale = Math.min(1, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
      if (scale < 1) {
        svg.setAttribute('width', String(Math.floor(w * scale)));
        svg.setAttribute('height', String(Math.floor(h * scale)));
      }
      let right = 0, bottom = 0;
      for (const el of [out, svg, ...svg.querySelectorAll('*')]) {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) { right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom); }
      }
      return { width: Math.min(Math.ceil(right) + 2, maxSide + 8), height: Math.min(Math.ceil(bottom) + 2, maxSide + 8) };
    } catch (error) {
      out.textContent = '';
      return { error: String(error && error.message || error) };
    }
    """

    /// A page for the side pane: the diagram as it was drawn, standing
    /// alone (no scripts needed to show it), centred, in both looks.
    public static func diagramPanePage(darkSVG: String, lightSVG: String, title: String) -> String {
        """
        <!doctype html><html><head><meta charset="utf-8"><title>\(escapeAttribute(title))</title>
        <meta name="color-scheme" content="light dark">
        <style>
        html,body{margin:0;min-height:100%}
        body{display:flex;justify-content:center;padding:24px;box-sizing:border-box;background:\(RichPalette.light.bg)}
        .look.dark{display:none}
        \(RichPalette.light.css)
        @media (prefers-color-scheme: dark){
          body{background:\(RichPalette.dark.bg)}
          .look.light{display:none}.look.dark{display:block}
        }
        .look.dark .pele{\(RichPalette.dark.css.replacingOccurrences(of: ".pele{", with: "").dropLast())}
        svg{max-width:100%;height:auto}
        </style></head><body><div class="look light">\(lightSVG)</div><div class="look dark">\(darkSVG)</div></body></html>
        """
    }
}

/// A ```print <id> fence in a reply (the pages experiment, called Prints;
/// ```page, its name before 10 Nov 2026, still works): the card for one
/// of the runner's Pages, drawn from the page as it is now, so a new
/// version shows in every reply that names it.
public enum PageFence {
    /// The page id in a fence whose info string is `page <id>` or whose
    /// body is the id, or nil for anything else.
    public static func id(language: String?, code: String) -> String? {
        let words = (language ?? "").split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard let word = words.first?.lowercased(), word == "print" || word == "page" else { return nil }
        let candidate = words.count > 1 ? String(words[1]) : code.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        return isPageId(candidate) ? candidate : nil
    }

    public static func isPageId(_ s: String) -> Bool {
        s.hasPrefix("pg_") && s.count <= 80 && s.dropFirst(3).allSatisfy { $0.isLowercase || $0.isNumber || $0 == "_" } && s.count > 3
    }
}
