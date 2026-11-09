import Foundation

/// A quote for the Librarian page (Customize > Quote of the day): one a
/// day, the same all day, changing at 4 am on this Mac's clock, with a
/// refresh button for another. The list ships with the app, so nothing is
/// fetched and nothing is sent.
///
/// Who's in it: writers, poets, scientists, engineers, designers, artists,
/// athletes and secular philosophers, each with where they said it. Not
/// religious figures, politicians, heads of state or military leaders,
/// nor tech founders and CEOs, and nothing political. Quotes whose wording
/// or source couldn't be pinned down, and well-known misattributions, are
/// left out; QuotesTests holds the list to these rules.
public struct Quote: Equatable, Sendable, Identifiable {
    public let text: String
    public let author: String
    /// Writer, physicist, artist...
    public let role: String
    /// Where it was said or written, and when.
    public let source: String

    public var id: String { "\(author): \(text)" }

    public init(_ text: String, _ author: String, _ role: String, _ source: String) {
        self.text = text
        self.author = author
        self.role = role
        self.source = source
    }
}

public enum Quotes {
    /// The day a quote belongs to: the local date, after taking 4 hours
    /// off, so a quote lasts through a late night and changes at 4 am.
    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let shifted = date.addingTimeInterval(-4 * 3600)
        let c = calendar.dateComponents([.year, .month, .day], from: shifted)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Today's quote, moved on `skips` times by the refresh button. The
    /// same day always gives the same quote, and the whole list goes round
    /// before one comes back: the days walk a fixed shuffle of it.
    public static func pick(dayKey: String, skips: Int = 0, from list: [Quote] = all) -> Quote? {
        guard !list.isEmpty else { return nil }
        let order = shuffled(list.count)
        let index = (days(dayKey) + max(0, skips)) % list.count
        return list[order[(index + list.count) % list.count]]
    }

    /// Days since 1 Jan 1970 for a yyyy-MM-dd key, by the calendar alone
    /// (no time zone), so the count is the same everywhere.
    static func days(_ key: String) -> Int {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return 0 }
        // Days from civil (Howard Hinnant's algorithm).
        let (y0, m, d) = (parts[0], parts[1], parts[2])
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }

    /// A fixed shuffle of 0..<count (a seeded Fisher-Yates), the same on
    /// every Mac and every launch.
    static func shuffled(_ count: Int) -> [Int] {
        var order = Array(0..<count)
        var seed: UInt64 = 0x7468_7265_6164_6265 // "threadbe"
        for i in stride(from: count - 1, to: 0, by: -1) {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let j = Int((seed >> 33) % UInt64(i + 1))
            order.swapAt(i, j)
        }
        return order
    }

    /// Text that may never be shown, whoever it's put down to: slogans
    /// tied to tech founders, and quotes usually pinned on the wrong person.
    public static let blockedText = [
        "done is better than perfect", "move fast and break things", "stay hungry, stay foolish",
        "insanity is doing the same thing", "be yourself; everyone else is already taken",
        "simplicity is the ultimate sophistication", "never too late to be what you might have been",
        "the secret of getting ahead is getting started", "culture eats strategy",
        "what gets measured gets managed", "10,000 ways that won't work",
    ]

    /// People who may never be quoted.
    public static let blockedAuthors = [
        "Elon Musk", "Mark Zuckerberg", "Steve Jobs", "Bill Gates", "Jeff Bezos", "Peter Thiel",
        "Reid Hoffman", "Paul Graham", "Naval Ravikant", "Marcus Aurelius", "Seneca", "Buddha",
        "Rumi", "Lao Tzu", "Confucius", "Winston Churchill", "Abraham Lincoln", "Grace Hopper",
    ]

    public static let all: [Quote] = [
        // Building
        Quote("The purpose of business is to create a customer.", "Peter Drucker", "Management writer", "The Practice of Management, 1954"),
        Quote("There is nothing so useless as doing efficiently that which should not be done at all.", "Peter Drucker", "Management writer", "Harvard Business Review, 1963"),
        Quote("Plan to throw one away; you will, anyhow.", "Fred Brooks", "Computer scientist", "The Mythical Man-Month, 1975"),
        Quote("A complex system that works is invariably found to have evolved from a simple system that worked.", "John Gall", "Writer", "Systemantics, 1975"),
        Quote("The best is the enemy of the good.", "Voltaire", "Writer", "1772, in translation"),
        Quote("Good is the enemy of great.", "Jim Collins", "Writer", "Good to Great, 2001"),
        Quote("People don't buy what you do; they buy why you do it.", "Simon Sinek", "Writer", "Start With Why, 2009"),
        Quote("The best way to predict the future is to invent it.", "Alan Kay", "Computer scientist", "Xerox PARC, 1971"),
        Quote("It is possible to fly without motors, but not without knowledge and skill.", "Wilbur Wright", "Inventor", "Letter to Octave Chanute, 1900"),
        Quote("Any sufficiently advanced technology is indistinguishable from magic.", "Arthur C. Clarke", "Writer", "Profiles of the Future, 1973"),
        Quote("Be so good they can't ignore you.", "Steve Martin", "Comedian and writer", "Born Standing Up, 2007"),
        Quote("If you do not work on an important problem, it's unlikely you'll do important work.", "Richard Hamming", "Mathematician", "You and Your Research, 1986"),
        Quote("A ship in harbor is safe, but that is not what ships are built for.", "John A. Shedd", "Writer", "Salt from My Attic, 1928"),
        // Craft
        Quote("Simplicity is prerequisite for reliability.", "Edsger W. Dijkstra", "Computer scientist", "EWD498, 1975"),
        Quote("Premature optimization is the root of all evil.", "Donald Knuth", "Computer scientist", "Structured Programming with go to Statements, 1974"),
        Quote("Debugging is twice as hard as writing the code in the first place.", "Brian Kernighan and P. J. Plauger", "Computer scientists", "The Elements of Programming Style, 1978"),
        Quote("Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", "Martin Fowler", "Engineer", "Refactoring, 1999"),
        Quote("Programs must be written for people to read, and only incidentally for machines to execute.", "Harold Abelson and Gerald Jay Sussman", "Computer scientists", "Structure and Interpretation of Computer Programs, 1985"),
        Quote("Talk is cheap. Show me the code.", "Linus Torvalds", "Engineer", "Linux kernel mailing list, 2000"),
        Quote("Good design is as little design as possible.", "Dieter Rams", "Designer", "Ten principles of good design"),
        Quote("Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.", "Antoine de Saint-Exupéry", "Writer", "Terre des Hommes, 1939, in translation"),
        Quote("What I cannot create, I do not understand.", "Richard Feynman", "Physicist", "His Caltech blackboard, 1988"),
        Quote("If I have seen further it is by standing on the shoulders of Giants.", "Isaac Newton", "Scientist", "Letter to Robert Hooke, 1676"),
        // Creativity and habits
        Quote("Inspiration is for amateurs. The rest of us just show up and get to work.", "Chuck Close", "Artist", "Interview, 2006"),
        Quote("Genius is one percent inspiration and ninety-nine percent perspiration.", "Thomas Edison", "Inventor", "Harper's Monthly, 1932"),
        Quote("You can't use up creativity. The more you use, the more you have.", "Maya Angelou", "Writer", "Bell Telephone Magazine, 1982"),
        Quote("Creativity is a habit, and the best creativity is the result of good work habits.", "Twyla Tharp", "Choreographer", "The Creative Habit, 2003"),
        Quote("It's only by going through a volume of work that you will close that gap.", "Ira Glass", "Radio host", "Interview, 2009"),
        Quote("First forget inspiration. Habit is more dependable.", "Octavia E. Butler", "Writer", "Furor Scribendi, 1995"),
        Quote("Almost all good writing begins with terrible first efforts.", "Anne Lamott", "Writer", "Bird by Bird, 1994"),
        Quote("If there's a book that you want to read, but it hasn't been written yet, then you must write it.", "Toni Morrison", "Writer", "Speech, 1981"),
        Quote("How we spend our days is, of course, how we spend our lives.", "Annie Dillard", "Writer", "The Writing Life, 1989"),
        Quote("You do not rise to the level of your goals. You fall to the level of your systems.", "James Clear", "Writer", "Atomic Habits, 2018"),
        Quote("We are what we repeatedly do. Excellence, then, is not an act, but a habit.", "Will Durant", "Historian", "The Story of Philosophy, 1926"),
        Quote("Great things are done by a series of small things brought together.", "Vincent van Gogh", "Artist", "Letter to Theo, 1882"),
        Quote("If you hear a voice within you say you cannot paint, then by all means paint, and that voice will be silenced.", "Vincent van Gogh", "Artist", "Letter to Theo, 1883"),
        Quote("Have no fear of perfection, you'll never reach it.", "Salvador Dalí", "Artist", "50 Secrets of Magic Craftsmanship, 1948"),
        // Mindset
        Quote("Life is like riding a bicycle. To keep your balance you must keep moving.", "Albert Einstein", "Physicist", "Letter to his son Eduard, 1930"),
        Quote("I have no special talents. I am only passionately curious.", "Albert Einstein", "Physicist", "Letter to Carl Seelig, 1952"),
        Quote("I've failed over and over and over again in my life. And that is why I succeed.", "Michael Jordan", "Athlete", "Nike advert, 1997"),
        Quote("Try again. Fail again. Fail better.", "Samuel Beckett", "Writer", "Worstward Ho, 1983"),
        Quote("The best way out is always through.", "Robert Frost", "Poet", "A Servant to Servants, 1914"),
        Quote("I am not afraid of storms, for I am learning how to sail my ship.", "Louisa May Alcott", "Writer", "Little Women, 1868"),
        Quote("Men are disturbed not by things, but by the opinions about things.", "Epictetus", "Philosopher", "Enchiridion 5, in translation"),
        Quote("The first principle is that you must not fool yourself, and you are the easiest person to fool.", "Richard Feynman", "Physicist", "Caltech commencement, 1974"),
        Quote("All we have to decide is what to do with the time that is given us.", "J. R. R. Tolkien", "Writer", "The Fellowship of the Ring, 1954"),
        Quote("Tell me, what is it you plan to do with your one wild and precious life?", "Mary Oliver", "Poet", "The Summer Day, 1990"),
        Quote("It is good to have an end to journey toward; but it is the journey that matters, in the end.", "Ursula K. Le Guin", "Writer", "The Left Hand of Darkness, 1969"),
        Quote("One never notices what has been done; one can only see what remains to be done.", "Marie Curie", "Scientist", "Letter to her brother, 1894"),
        Quote("I love deadlines. I love the whooshing noise they make as they go by.", "Douglas Adams", "Writer", "The Salmon of Doubt, 2002"),
        Quote("No human is limited.", "Eliud Kipchoge", "Athlete", "INEOS 1:59 Challenge, 2019"),
        Quote("Pressure is a privilege.", "Billie Jean King", "Athlete", "Pressure Is a Privilege, 2008"),
    ]
}
