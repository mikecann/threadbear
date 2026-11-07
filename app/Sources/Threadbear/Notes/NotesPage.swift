import SwiftUI
import ThreadbearCore

/// The Notes page (the bar's Notes, under Skills), over the main panel as
/// Settings and Skills are: Mike's own notes, kept encrypted on this Mac
/// (NotesStore). The list on the left, newest first; the note on the
/// right, its title above a code-editor style box with line numbers.
struct NotesPage: View {
    @Environment(AppModel.self) private var app
    @State private var store = NotesStore.shared
    @State private var selection: String?
    @State private var title = ""
    @State private var deleting: Note?
    @FocusState private var titleFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: zoomed(10)) {
                Text("Notes")
                    .font(.system(size: zoomed(17), weight: .semibold))
                Image(systemName: "lock.fill")
                    .font(.system(size: zoomed(10)))
                    .foregroundStyle(.tertiary)
                    .tip("Encrypted on this Mac. Never sent anywhere, and agents can't read them")
                Spacer()
                Button {
                    newNote()
                } label: {
                    Label("New Note", systemImage: "square.and.pencil")
                }
                .tip("Start a new note")
                Button {
                    close()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: zoomed(12), weight: .semibold))
                        .frame(width: zoomed(28), height: zoomed(28))
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .tip("Close Notes (Esc)")
                .accessibilityLabel("Close Notes")
            }
            // Clear of the divider's resize grab (SettingsPage says why).
            .padding(.leading, zoomed(20))
            .padding(.trailing, zoomed(28))
            .padding(.vertical, zoomed(10))
            Divider()
            if let problem = store.problem {
                Text(problem)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack(spacing: 0) {
                    list
                        .frame(width: zoomed(220))
                    Divider()
                    editor
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onExitCommand { close() }
        .onAppear {
            store.load()
            if selection == nil { pick(store.sorted.first?.id) }
        }
        .onDisappear { store.flush() }
        .confirmationDialog("Delete “\(deleting?.title ?? "")”?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Delete", role: .destructive) {
                if let note = deleting { delete(note) }
            }
        } message: {
            Text("It can't be brought back.")
        }
    }

    // MARK: The list

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: zoomed(2)) {
                ForEach(store.sorted) { note in
                    NoteRow(note: note, selected: note.id == selection)
                        .contentShape(Rectangle())
                        .onTapGesture { pick(note.id) }
                        .iconContextMenu {
                            Button("Rename", systemImage: "pencil") {
                                pick(note.id)
                                titleFocused = true
                            }
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = note }
                        }
                        .tip(note.title)
                }
                if store.notes.isEmpty {
                    Text("No notes yet. New Note starts one.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(zoomed(14))
                }
            }
            .padding(zoomed(8))
        }
    }

    // MARK: The note

    @ViewBuilder private var editor: some View {
        if let id = selection, let note = store.notes.first(where: { $0.id == id }) {
            VStack(spacing: 0) {
                HStack(spacing: zoomed(8)) {
                    TextField("Title", text: $title)
                        .textFieldStyle(.plain)
                        .font(.system(size: zoomed(16), weight: .semibold))
                        .focused($titleFocused)
                        .onSubmit { store.rename(id, to: title); title = store.notes.first { $0.id == id }?.title ?? title }
                        .onChange(of: titleFocused) { _, focused in if !focused { store.rename(id, to: title) } }
                        .tip("The note's name. Click to rename it")
                    Spacer()
                    Text(note.updatedAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .fixedSize()
                    Button {
                        deleting = note
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                    .tip("Delete this note")
                }
                .padding(.horizontal, zoomed(16))
                .padding(.vertical, zoomed(10))
                Divider()
                NoteEditor(noteId: id, text: note.body) { store.setBody(id, $0) }
            }
        } else {
            VStack(spacing: zoomed(10)) {
                Image(systemName: "note.text")
                    .font(.system(size: zoomed(28)))
                    .foregroundStyle(.tertiary)
                Text("Pick a note, or start a new one.")
                    .foregroundStyle(.secondary)
                Button("New Note", action: newNote)
                    .tip("Start a new note")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func pick(_ id: String?) {
        if let current = selection, titleFocused { store.rename(current, to: title) }
        store.flush()
        selection = id
        title = id.flatMap { id in store.notes.first { $0.id == id }?.title } ?? ""
    }

    private func newNote() {
        guard let note = store.create() else { return }
        pick(note.id)
    }

    private func delete(_ note: Note) {
        let next = store.sorted.first { $0.id != note.id }?.id
        store.delete(note.id)
        if selection == note.id { pick(next) }
        deleting = nil
    }

    private func close() {
        if let id = selection, titleFocused { store.rename(id, to: title) }
        store.flush()
        app.showsNotesPage = false
    }
}

private struct NoteRow: View {
    let note: Note
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(2)) {
            Text(note.title)
                .font(.body.weight(.medium))
                .lineLimit(1)
            Text(preview)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, zoomed(10))
        .padding(.vertical, zoomed(7))
        .background(RoundedRectangle(cornerRadius: zoomed(7)).fill(selected ? Color.primary.opacity(0.09) : .clear))
    }

    private var preview: String {
        let first = note.body.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return first.map { String($0) } ?? note.updatedAt.formatted(date: .abbreviated, time: .omitted)
    }
}
