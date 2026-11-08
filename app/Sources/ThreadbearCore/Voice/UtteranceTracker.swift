import Foundation

/// Turns the speech recogniser's stream of results into things Mike said.
/// The recogniser sends volatile guesses that it later replaces with final
/// text, each for a stretch of the audio (seconds from the start). Once
/// he's paused for `pause` seconds whatever he's said since the last send
/// goes, and anything the recogniser finalises later for audio that was
/// already sent is dropped, so nothing goes twice.
public struct UtteranceTracker: Sendable {
    public struct Result: Sendable, Equatable {
        public var text: String
        /// The stretch of audio it covers, in seconds.
        public var start: Double
        public var end: Double
        public var isFinal: Bool

        public init(text: String, start: Double, end: Double, isFinal: Bool) {
            self.text = text
            self.start = start
            self.end = end
            self.isFinal = isFinal
        }
    }

    /// How long a pause ends what he's saying.
    public var pause: Double
    /// Final text not yet sent, oldest first.
    private var finals: [Result] = []
    /// The newest guess at what comes after them.
    private var volatile: Result?
    /// Audio up to here has been sent.
    private(set) public var sentThrough: Double = -1
    /// When (clock time) the last result with words came in.
    private var lastHeard: Double?
    /// The words that went last, and where in the audio they started: the
    /// recogniser goes on revising that stretch after it's gone (a later
    /// guess, then its final text, each reaching a little further), and
    /// only words past these are new.
    private var lastSent: [Substring] = []
    private var lastSentStart: Double = -1

    public init(pause: Double = 1.0) {
        self.pause = pause
    }

    /// What he's said so far that hasn't gone, for the live caption.
    public var pending: String {
        Self.join((finals + [volatile].compactMap { $0 }).map(\.text))
    }

    /// Where in the audio what's waiting starts (seconds).
    public var pendingStart: Double? {
        (finals + [volatile].compactMap { $0 }).map(\.start).min()
    }

    /// Whether anything is waiting to go.
    public var hasWords: Bool { !pending.isEmpty }

    /// Takes a result from the recogniser. True when it had new words in
    /// it (so whatever is speaking should stop: he's talking).
    @discardableResult
    public mutating func add(_ result: Result, now: Double) -> Bool {
        // Audio already sent: the recogniser finalising what went.
        guard result.end > sentThrough + 0.001 else { return false }
        var result = result
        // A revision of what went, reaching a little further: only the
        // words after it are new. Without this every phrase went twice,
        // once as a guess and again as final text (8 Nov, Fn dictation).
        if result.start < sentThrough - 0.001 {
            guard let rest = Self.words(of: result.text, after: result.start >= lastSentStart - 0.001 ? lastSent : []) else { return false }
            result.text = rest
            result.start = sentThrough
        }
        let words = !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if result.isFinal {
            if words { finals.append(result) }
            if let v = volatile, v.end <= result.end + 0.001 { volatile = nil }
        } else {
            volatile = words ? result : nil
        }
        if words { lastHeard = now }
        return words
    }

    /// What to send now, if he's paused long enough after saying something.
    public mutating func take(now: Double) -> String? {
        guard let lastHeard, now - lastHeard >= pause, hasWords else { return nil }
        return flush()
    }

    /// Sends whatever there is now (voice mode turned off mid-sentence).
    public mutating func flush() -> String? {
        let text = pending
        let end = (finals.map(\.end) + [volatile?.end].compactMap { $0 }).max() ?? sentThrough
        if let start = pendingStart, !text.isEmpty {
            lastSent = text.split(whereSeparator: \.isWhitespace)
            lastSentStart = start
        }
        finals = []
        volatile = nil
        lastHeard = nil
        sentThrough = max(sentThrough, end)
        return text.isEmpty ? nil : text
    }

    /// The words of `text` after the ones that went (`sent`), or nil if
    /// there are none. Compared without case or punctuation, as the final
    /// text capitalises and punctuates the guess. With nothing to compare
    /// against, all of it overlapped what went, so none of it is new.
    static func words(of text: String, after sent: [Substring]) -> String? {
        let words = text.split(whereSeparator: \.isWhitespace)
        guard !sent.isEmpty else { return nil }
        func plain(_ word: Substring) -> String { word.lowercased().filter { $0.isLetter || $0.isNumber } }
        var matched = 0
        while matched < min(words.count, sent.count), plain(words[matched]) == plain(sent[matched]) { matched += 1 }
        // A reworded revision: skip as many words as went, so it isn't typed twice.
        let skip = matched == sent.count ? matched : sent.count
        guard words.count > skip else { return nil }
        return words[skip...].joined(separator: " ")
    }

    static func join(_ parts: [String]) -> String {
        parts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
