import Foundation
import XCTest
@testable import ThreadbearCore

/// The Librarian page's Threadbear activity (ThreadActivity.swift and the
/// `activity` part of LibrarianLook): counted by this Mac's day, private
/// folders left out, shaded by the busiest day, off until turned on, and
/// with the numbers until moved on its own.
final class ThreadActivityTests: XCTestCase {
    private let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()

    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testCountsThreadsByDayInTheYearAndLeavesOutPrivateFolders() {
        let threads: [(createdAt: Date, cwd: String)] = [
            (at("2026-11-04T09:00:00Z"), "/Users/w/repo"),
            (at("2026-11-04T22:00:00Z"), "/Users/w/repo"),
            (at("2026-11-05T10:00:00Z"), "/Users/w/notes"),
            (at("2026-11-05T11:00:00Z"), "/Users/w/secret/deep"),
            (at("2025-12-31T23:00:00Z"), "/Users/w/repo"),
        ]
        let year = ThreadActivity.year(2026, threads: threads, privateFolders: ["/Users/w/secret"], calendar: utc)
        XCTAssertEqual(year.year, 2026)
        XCTAssertEqual(year.total, 3)
        XCTAssertEqual(year.days.map(\.date), ["2026-11-04", "2026-11-05"])
        XCTAssertEqual(year.days.map(\.count), [2, 1])
        XCTAssertEqual(year.days.map(\.level), [4, 2])
        // Drawn by the same calendar as GitHub's: every day of the year.
        XCTAssertEqual(year.weeks().flatMap { $0 }.compactMap { $0 }.count, 365)
    }

    func testTheDayIsThisMacsDay() {
        var la = Calendar(identifier: .gregorian)
        la.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let year = ThreadActivity.year(2026, threads: [(at("2026-11-05T03:00:00Z"), "/x")], calendar: la)
        XCTAssertEqual(year.days.map(\.date), ["2026-11-04"])
    }

    func testLevels() {
        XCTAssertEqual(ThreadActivity.level(0, most: 10), 0)
        XCTAssertEqual(ThreadActivity.level(1, most: 10), 1)
        XCTAssertEqual(ThreadActivity.level(5, most: 10), 2)
        XCTAssertEqual(ThreadActivity.level(10, most: 10), 4)
        XCTAssertEqual(ThreadActivity.level(1, most: 1), 4)
    }

    func testPrivateFolders() {
        XCTAssertTrue(ThreadActivity.isPrivate("/a/b", folders: ["/a/b"]))
        XCTAssertTrue(ThreadActivity.isPrivate("/a/b/c", folders: ["/a/b/"]))
        XCTAssertFalse(ThreadActivity.isPrivate("/a/bc", folders: ["/a/b"]))
        XCTAssertFalse(ThreadActivity.isPrivate("/a/b", folders: [""]))
        XCTAssertTrue(ThreadActivity.isPrivate(NSHomeDirectory() + "/p/q", folders: ["~/p"]))
    }

    func testFirstYear() {
        XCTAssertNil(ThreadActivity.firstYear([]))
        XCTAssertEqual(ThreadActivity.firstYear([at("2026-03-01T12:00:00Z"), at("2025-06-01T12:00:00Z")], calendar: utc), 2025)
    }

    func testThePartStartsOffAndFollowsTheNumbers() throws {
        var look = LibrarianLook()
        XCTAssertFalse(look.shows(.activity))
        XCTAssertFalse(look.layout.contains(.activity))
        look.setShown(true, for: .activity)
        XCTAssertEqual(look.layout, [.picture, .about, .numbers, .activity, .settings])
        // With the numbers wherever they go, until moved on its own.
        look.setPlace(.bottom, for: .numbers)
        XCTAssertEqual(look.layout, [.picture, .about, .numbers, .activity, .settings])
        look.setPlace(.top, for: .activity)
        XCTAssertEqual(look.layout, [.picture, .about, .activity, .numbers, .settings])
        // Numbers went to the bottom, so GitHub (middle) is between them.
        XCTAssertEqual(ProfilePageSettings.cardOrder(look), ["activity", "github", "numbers", "projects"])
        // Saved and loaded.
        let back = LibrarianLook.load(look.data())
        XCTAssertEqual(back, look)
        XCTAssertTrue(back.activityShown)
        // A look saved before the part existed loads with it off.
        let old = try JSONSerialization.data(withJSONObject: ["picture": "bear", "quoteShown": true])
        XCTAssertFalse(LibrarianLook.load(old).activityShown)
    }
}
