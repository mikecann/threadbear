import SwiftUI
import ThreadbearCore

/// What was searched for in each folder, per thread, so Back from a hit
/// finds the same results. Only while the app runs.
@MainActor
enum FolderSearchMemory {
    static var queries: [String: String] = [:]
}

/// A folder in the pane with a search over it: type, and the text inside
/// the folder's files is searched (FolderSearch), the folder's list giving
/// way to the lines that match, file by file. Clicking one opens the file
/// at that line, and Back comes back to the results. Empty, it's the
/// folder as before. Only for this Mac's folders: another Mac's aren't
/// here to read.
struct FolderSearchView<Browser: View>: View {
    @Environment(AppModel.self) private var app
    let thread: ThreadSummary
    let root: String
    let preview: PanePreview
    @ViewBuilder let browser: () -> Browser

    @State private var query: String
    @State private var result = FolderSearch.Result()
    @State private var searching = false


    init(thread: ThreadSummary, root: String, preview: PanePreview, @ViewBuilder browser: @escaping () -> Browser) {
        self.thread = thread
        self.root = root
        self.preview = preview
        self.browser = browser
        _query = State(initialValue: FolderSearchMemory.queries["\(thread.id) \(root)"] ?? "")
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            SearchField(text: $query, prompt: "Search in files")
                .padding(.horizontal, zoomed(8))
                .padding(.vertical, zoomed(6))
            Divider()
            if trimmed.isEmpty {
                browser()
            } else {
                results
            }
        }
        .task(id: trimmed) {
            FolderSearchMemory.queries["\(thread.id) \(root)"] = query
            guard !trimmed.isEmpty else { result = FolderSearch.Result(); searching = false; return }
            searching = true
            // A pause for typing, then the walk off the main thread. A new
            // letter cancels this task, and the walk checks for that.
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            let root = root, query = trimmed
            let task = Task.detached(priority: .userInitiated) {
                FolderSearch.search(root: root, query: query, stop: { Task.isCancelled })
            }
            let found = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
            if Task.isCancelled { return }
            result = found
            searching = false
        }
    }

    @ViewBuilder
    private var results: some View {
        if searching && result.hits.isEmpty {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .tip("Searching the files in this folder")
        } else if result.hits.isEmpty {
            PaneNote(text: "Nothing in this folder's files has \"\(trimmed)\".")
        } else {
            let files = Dictionary(grouping: result.hits, by: \.path)
            let order = result.hits.map(\.path).reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                    Text(summary(files: order.count))
                        .font(.system(size: TypeScale.small))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, zoomed(12))
                        .padding(.vertical, zoomed(6))
                    ForEach(order, id: \.self) { path in
                        FileHeader(path: path, shown: FolderSearch.relative(path, to: root), count: files[path]?.count ?? 0)
                        ForEach(files[path] ?? []) { hit in
                            HitRow(hit: hit, query: trimmed) {
                                app.openSearchHit(hit, query: trimmed, showing: preview, in: thread)
                            }
                        }
                    }
                }
                .padding(.bottom, zoomed(10))
            }
        }
    }

    private func summary(files: Int) -> String {
        let lines = result.hits.count
        let base = "\(lines) \(lines == 1 ? "line" : "lines") in \(files) \(files == 1 ? "file" : "files")"
        return result.cut ? "The first \(base). Add more words to narrow it." : base
    }
}

private struct FileHeader: View {
    let path: String
    /// The path under the folder searched.
    let shown: String
    let count: Int

    var body: some View {
        HStack(spacing: zoomed(6)) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: path))
                .resizable()
                .frame(width: zoomed(14), height: zoomed(14))
            Text(shown)
                .font(.system(size: TypeScale.label, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            Text("\(count)")
                .font(.system(size: TypeScale.small))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, zoomed(12))
        .padding(.top, zoomed(8))
        .padding(.bottom, zoomed(2))
        .tip(shown)
    }
}

/// One matching line: its number and the line, the words in bold.
private struct HitRow: View {
    let hit: FolderSearch.Hit
    let query: String
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
                Text("\(hit.line)")
                    .font(.system(size: TypeScale.small).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .frame(minWidth: zoomed(28), alignment: .trailing)
                Text(marked)
                    .font(.system(size: TypeScale.small, design: .monospaced))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, zoomed(8))
            .padding(.vertical, zoomed(3))
            .background(hovering ? SidebarMetrics.hover : .clear, in: RoundedRectangle(cornerRadius: zoomed(5)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, zoomed(4))
        .onHover { hovering = $0 }
        .tip("Open \((hit.path as NSString).lastPathComponent) at line \(hit.line)")
    }

    private var marked: AttributedString {
        var text = AttributedString(hit.text)
        var from = text.startIndex
        while let range = text[from...].range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) {
            text[range].font = .system(size: TypeScale.small, weight: .bold, design: .monospaced)
            text[range].foregroundColor = .primary
            from = range.upperBound
        }
        return text
    }
}
