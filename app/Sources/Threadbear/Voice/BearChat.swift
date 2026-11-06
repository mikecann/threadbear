import AppKit
import ThreadbearCore

/// The bear at the top right of the sidebar: one place to chat about
/// anything, out loud too, that remembers. It's an ordinary thread in its
/// own folder, ~/ThreadbearThreads/Bear, so it has the same tools and
/// approvals as any other. The remembering is the folder's: Claude Code
/// keeps a memory for each folder, and the folder's CLAUDE.md (written
/// once, never overwritten, so it is the user's to change) tells the bear to
/// keep what it learns about him there. A new chat there, after the last
/// was archived, still knows him.
@MainActor
enum BearChat {
    /// Settings > General's switch for the sidebar's bear. Off only hides
    /// the button: the bear's chats, memory and Voice carry on.
    static let shownKey = "bearShown"

    static var folder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("ThreadbearThreads/Bear", isDirectory: true)
    }

    static let instructions = """
    # The bear

    You are the bear, Threadbear's mascot: a warm, capable personal assistant
    the user chats with about anything. Casual questions, ideas, plans, what to
    cook, help with their day, and real work when they ask for it.

    - Talk like a friend who knows them: short, plain, natural replies. The
      user often talks to you out loud and hears your reply spoken, so keep
      it to a few sentences unless they ask for more, and skip tables and
      heavy formatting unless they ask for them.
    - When a casual question turns into something to do, do it: give the
      recipe and the steps, make the list, look things up, draft the
      message, and say what you'd do next.
    - Remember. Whenever you learn something lasting about the user (who
      they are, people and places in their life, what they like, what
      they're working on, what they asked you to keep in mind), save it to
      your memory straight away, and read your memory at the start of a
      chat so you pick up where you left off. Never save passwords, keys
      or codes.
    - This folder is yours for notes and files you make for them.
    """

    /// Makes the folder and its CLAUDE.md the first time.
    static func prepare() {
        let fm = FileManager.default
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("CLAUDE.md")
        if !fm.fileExists(atPath: file.path) {
            try? instructions.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    /// The bear's newest chat that isn't archived, on this Mac.
    static func thread(in threads: [String: ThreadSummary]) -> ThreadSummary? {
        let path = folder.standardizedFileURL.path
        return threads.values
            .filter { !$0.isRemote && $0.archivedAt == nil && URL(fileURLWithPath: ($0.cwd as NSString).expandingTildeInPath).standardizedFileURL.path == path }
            .max { $0.lastActivityAt < $1.lastActivityAt }
    }

    /// Opens the chat, starting Voice with it if `talk`. With no chat yet,
    /// a new one: the composer aimed at the bear's folder, or for Voice,
    /// a chat started with a hello so there's a thread to talk with.
    static func open(app: AppModel, talk: Bool) {
        prepare()
        if let thread = thread(in: app.threads) {
            app.select(thread.id)
            if talk, !VoiceMode.shared.isOn(for: thread.id) { VoiceMode.shared.start(threadId: thread.id) }
            return
        }
        app.newThread()
        app.newThreadCwd = folder.path
        // Listening on the empty chat: what he says first starts it.
        if talk, VoiceMode.enabled { VoiceMode.shared.start(threadId: VoiceMode.newThread) }
    }
}

extension AppModel {
    /// A new thread from what he said in Voice on the new-thread composer,
    /// with its folder, login and model as the composer has them (the
    /// bear's folder for the bear's chat). `then` gets its id before it's
    /// selected (so Voice carries on in it), or nil if it couldn't be made.
    func startThreadSpoken(_ text: String, then: @escaping (String?) -> Void) {
        guard let client, connection == .connected, !creatingThread else { then(nil); return }
        let request = newThreadRequest(text: text, images: [])
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                let thread = try await client.createThread(request)
                newThreadCwd = nil
                threads[thread.id] = thread
                then(thread.id)
                select(thread.id)
            } catch {
                then(nil)
                show(error)
            }
        }
    }
}
