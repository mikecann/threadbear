import XCTest
@testable import ThreadbearCore

final class SkillMentionsTests: XCTestCase {
    let names: Set<String> = ["pele", "anatomy"]

    private func found(_ text: String) -> [String] {
        SkillMentions.ranges(in: text, names: names).map { (text as NSString).substring(with: $0) }
    }

    func testFindsInstalledSkillsAsWords() {
        XCTAssertEqual(found("/pele draw the checkout flow"), ["/pele"])
        XCTAssertEqual(found("use /anatomy, then (/pele)"), ["/anatomy", "/pele"])
        XCTAssertEqual(found("/PELE please"), ["/PELE"])
    }

    func testLeavesPathsAndOtherWordsAlone() {
        XCTAssertEqual(found("open src/pele/render.mjs"), [])
        XCTAssertEqual(found("~/pele and ./pele and https://x.com/pele"), [])
        XCTAssertEqual(found("/peler /unknown /pele-x"), [])
        XCTAssertEqual(found("no slashes"), [])
    }

    func testLinks() {
        let url = SkillMentions.url(for: "pele")!
        XCTAssertEqual(SkillMentions.name(of: url), "pele")
        XCTAssertNil(SkillMentions.name(of: URL(string: "https://example.com")!))
    }
}
