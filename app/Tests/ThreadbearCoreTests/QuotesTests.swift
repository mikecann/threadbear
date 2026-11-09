import Foundation
import XCTest
@testable import ThreadbearCore

final class QuotesTests: XCTestCase {
    private func date(_ text: String, _ zone: String) -> (Date, Calendar) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return (f.date(from: text)!, calendar)
    }

    func testTheDayTurnsOverAt4amLocal() {
        for zone in ["America/Los_Angeles", "UTC", "Asia/Tokyo"] {
            let (late, c1) = date("2026-11-09 03:59", zone)
            let (four, c2) = date("2026-11-09 04:00", zone)
            XCTAssertEqual(Quotes.dayKey(late, calendar: c1), "2026-11-08", zone)
            XCTAssertEqual(Quotes.dayKey(four, calendar: c2), "2026-11-09", zone)
        }
    }

    func testSameDaySameQuoteAndTheListGoesRoundBeforeRepeating() {
        XCTAssertEqual(Quotes.pick(dayKey: "2026-11-09"), Quotes.pick(dayKey: "2026-11-09"))
        XCTAssertEqual(Quotes.days("1970-01-01"), 0)
        XCTAssertEqual(Quotes.days("2026-11-09") - Quotes.days("2026-11-08"), 1)
        XCTAssertEqual(Quotes.days("2025-01-01") - Quotes.days("2024-12-31"), 1)
        // One full cycle of days shows every quote once.
        let start = Quotes.days("2026-01-01")
        var seen = Set<String>()
        for skip in 0..<Quotes.all.count {
            seen.insert(Quotes.pick(dayKey: "2026-01-01", skips: skip)!.id)
        }
        XCTAssertEqual(seen.count, Quotes.all.count)
        XCTAssertGreaterThan(start, 0)
        XCTAssertNotEqual(Quotes.pick(dayKey: "2026-11-09", skips: 1), Quotes.pick(dayKey: "2026-11-09"))
        XCTAssertNil(Quotes.pick(dayKey: "2026-11-09", from: []))
    }

    func testEveryQuoteKeepsTheRules() {
        XCTAssertGreaterThanOrEqual(Quotes.all.count, 40)
        XCTAssertEqual(Set(Quotes.all.map(\.id)).count, Quotes.all.count, "no quote twice")
        for quote in Quotes.all {
            XCTAssertFalse(quote.text.isEmpty)
            XCTAssertFalse(quote.author.isEmpty)
            XCTAssertFalse(quote.role.isEmpty, quote.text)
            XCTAssertFalse(quote.source.isEmpty, "every quote says where it's from: \(quote.text)")
            XCTAssertFalse(Quotes.blockedAuthors.contains { quote.author.localizedCaseInsensitiveContains($0) }, quote.author)
            XCTAssertFalse(Quotes.blockedText.contains { quote.text.localizedCaseInsensitiveContains($0) }, quote.text)
            XCTAssertFalse(quote.text.contains("—"), "no em dashes in UI copy")
        }
    }

    func testRefreshLastsTheDay() {
        var look = LibrarianLook()
        XCTAssertFalse(look.shows(.quote), "off until turned on")
        look.setShown(true, for: .quote)
        XCTAssertEqual(look.layout, [.picture, .about, .quote, .numbers, .settings])
        look.skipQuote(on: "2026-11-09")
        look.skipQuote(on: "2026-11-09")
        XCTAssertEqual(look.quoteSkips(on: "2026-11-09"), 2)
        XCTAssertEqual(look.quoteSkips(on: "2026-11-10"), 0, "a new day starts again")
        look.skipQuote(on: "2026-11-10")
        XCTAssertEqual(look.quoteSkips(on: "2026-11-10"), 1)
        XCTAssertEqual(LibrarianLook.load(look.data()), look)
    }
}
