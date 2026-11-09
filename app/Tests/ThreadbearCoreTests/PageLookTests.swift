import Foundation
import XCTest
@testable import ThreadbearCore

final class PageLookTests: XCTestCase {
    func testStandardLookIsThePageAsItWas() {
        let look = LibrarianLook.standard
        // GitHub stays off until there's a user name.
        XCTAssertEqual(look.layout, [.picture, .about, .numbers, .settings])
        XCTAssertTrue(look.isStandard)
    }

    func testPartsMoveBetweenPlacesAndKeepTheirOrderWithin() {
        var look = LibrarianLook()
        look.githubUser = "waynesutton"
        look.setPlace(.bottom, for: .picture)
        look.setPlace(.top, for: .github)
        XCTAssertEqual(look.layout, [.about, .github, .numbers, .picture, .settings])
        // Moving back to where it starts isn't stored as a change.
        look.setPlace(.top, for: .picture)
        look.setPlace(.middle, for: .github)
        look.githubUser = ""
        XCTAssertTrue(look.isStandard)
    }

    func testHiddenPartsAndPictureChoices() {
        var look = LibrarianLook()
        look.setShown(false, for: .numbers)
        look.picture = .none
        XCTAssertEqual(look.layout, [.about, .settings])
        look.picture = .own
        XCTAssertFalse(look.shows(.picture), "your picture needs a file")
        look.pictureFile = "picture.png"
        XCTAssertTrue(look.shows(.picture))
        look.setShown(true, for: .numbers)
        XCTAssertEqual(look.layout, [.picture, .about, .numbers, .settings])
    }

    func testRoundTripsAndToleratesOtherBuilds() throws {
        var look = LibrarianLook()
        look.picture = .own
        look.pictureFile = "a.png"
        look.background = "b.jpg"
        look.backgroundDim = 0.3
        look.pictureSize = .large
        look.setPlace(.bottom, for: .numbers)
        look.hidden = [.settings]
        look.hiddenNumbers = ["Waiting"]
        look.githubUser = "octocat"
        XCTAssertEqual(LibrarianLook.load(look.data()), look)

        let odd = #"{"picture":"hologram","places":{"numbers":"top","rocket":"top","about":"sideways"},"hidden":["github","rocket"],"backgroundDim":7,"newThing":1}"#
        let loaded = LibrarianLook.load(Data(odd.utf8))
        XCTAssertEqual(loaded.picture, .bear)
        XCTAssertEqual(loaded.place(.numbers), .top)
        XCTAssertEqual(loaded.place(.about), .top)
        XCTAssertEqual(loaded.hidden, [.github])
        XCTAssertEqual(loaded.backgroundDim, 1)
        XCTAssertEqual(LibrarianLook.load(Data("nonsense".utf8)), .standard)
        XCTAssertEqual(LibrarianLook.load(nil), .standard)
    }

    func testGitHubUserNames() {
        XCTAssertEqual(GitHubUser.clean(" @waynesutton "), "waynesutton")
        XCTAssertEqual(GitHubUser.clean("https://github.com/mikecann/threadbear"), "mikecann")
        XCTAssertEqual(GitHubUser.clean("a-b"), "a-b")
        XCTAssertEqual(GitHubUser.clean("a--b"), "")
        XCTAssertEqual(GitHubUser.clean("-ab"), "")
        XCTAssertEqual(GitHubUser.clean("a b"), "")
        XCTAssertEqual(GitHubUser.clean("ab?y=1"), "")
        XCTAssertEqual(GitHubUser.clean("é"), "")
        XCTAssertEqual(GitHubUser.clean(String(repeating: "a", count: 40)), "")
        XCTAssertEqual(GitHubContributions.url(user: "@octocat", year: 2026)?.absoluteString,
                       "https://github-contributions-api.jogruber.de/v4/octocat?y=2026")
        XCTAssertNil(GitHubContributions.url(user: "", year: 2026))
    }

    func testParsesTheServiceAndItsErrors() throws {
        let json = #"{"total":{"2026":9},"contributions":[{"date":"2026-01-02","count":5,"level":2},{"date":"2026-01-01","count":4,"level":9},{"date":"2025-12-31","count":1,"level":1}]}"#
        let year = try GitHubContributions.parse(Data(json.utf8), year: 2026)
        XCTAssertEqual(year.total, 9)
        XCTAssertEqual(year.days.map(\.date), ["2026-01-01", "2026-01-02"])
        XCTAssertEqual(year.days.first?.level, 4, "levels are kept to 0...4")

        XCTAssertThrowsError(try GitHubContributions.parse(Data(#"{"error":"Not found"}"#.utf8), year: 2026)) {
            XCTAssertEqual($0 as? GitHubContributions.ParseError, .service("Not found"))
        }
        XCTAssertThrowsError(try GitHubContributions.parse(Data("<html>".utf8), year: 2026))
    }

    func testCalendarHasEveryDayInPlace() {
        // 1 Jan 2026 is a Thursday: four empty cells above it.
        let year = GitHubContributions(year: 2026, total: 3, days: [.init(date: "2026-01-01", count: 3, level: 2)])
        let weeks = year.weeks()
        XCTAssertEqual(weeks.count, 53)
        XCTAssertTrue(weeks.allSatisfy { $0.count == 7 })
        XCTAssertEqual(weeks[0].prefix(4).compactMap { $0 }.count, 0)
        XCTAssertEqual(weeks[0][4]?.date, "2026-01-01")
        XCTAssertEqual(weeks[0][4]?.count, 3)
        XCTAssertEqual(weeks.flatMap { $0 }.compactMap { $0 }.count, 365)
        XCTAssertEqual(weeks.last?.compactMap { $0 }.last?.date, "2026-12-31")

        let months = year.monthStarts()
        XCTAssertEqual(months.count, 12)
        XCTAssertEqual(months.first?.month, "Jan")
        XCTAssertEqual(months.first?.week, 0)
        XCTAssertEqual(months.last?.month, "Dec")
    }

    func testGreetingByTheClock() {
        XCTAssertEqual(Greeting.text(hour: 5, name: "Wayne"), "Good morning, Wayne")
        XCTAssertEqual(Greeting.text(hour: 11, name: " Wayne "), "Good morning, Wayne")
        XCTAssertEqual(Greeting.text(hour: 12, name: "Wayne"), "Good afternoon, Wayne")
        XCTAssertEqual(Greeting.text(hour: 17, name: ""), "Good evening")
        XCTAssertEqual(Greeting.text(hour: 22, name: "Wayne"), "Good night, Wayne")
        XCTAssertEqual(Greeting.text(hour: 0, name: "Wayne"), "Good night, Wayne")
        XCTAssertEqual(Greeting.text(hour: 4, name: "Wayne"), "Good night, Wayne")
        XCTAssertEqual(Greeting.firstName("Wayne Sutton"), "Wayne")
        XCTAssertEqual(Greeting.firstName(""), "")
    }

    func testGreetingAndTitlePartsAreOffOrOnByThemselves() {
        var look = LibrarianLook()
        XCTAssertFalse(look.shows(.greeting), "a look saved before the greeting doesn't grow one")
        look.setShown(true, for: .greeting)
        XCTAssertEqual(look.layout.first, .greeting)
        look.setShown(false, for: LibrarianLook.AboutPart.title)
        look.setShown(false, for: LibrarianLook.AboutPart.line)
        XCTAssertTrue(look.shows(.about), "the status line is still there")
        look.setShown(false, for: LibrarianLook.AboutPart.status)
        XCTAssertFalse(look.shows(.about), "nothing left of it, so no gap")
        look.greetingName = "Wayne"
        look.greetingClock = false
        XCTAssertEqual(LibrarianLook.load(look.data()), look)
        let old = LibrarianLook.load(Data(#"{"picture":"bear"}"#.utf8))
        XCTAssertFalse(old.greetingShown)
        XCTAssertTrue(old.greetingClock)
        XCTAssertEqual(old.hiddenAbout, [])
    }
}
