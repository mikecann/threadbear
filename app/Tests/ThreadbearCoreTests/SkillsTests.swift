import XCTest
@testable import ThreadbearCore

final class SkillsTests: XCTestCase {
    func testDecodesTheRunnersList() throws {
        let json = """
        {"skills":[{"name":"anatomy","description":"Machines","always":false,
          "source":{"kind":"github","repo":"wheresryan22/anatomy","url":"https://github.com/wheresryan22/anatomy"},
          "commit":"1482e84aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","dir":"/x/anatomy@1482e84","addedAt":"2026-11-06T00:00:00Z"},
          {"name":"pele","description":"Diagrams","always":true,"source":{"kind":"builtin"},"commit":"builtin-1.2.3","dir":"/x/pele","addedAt":""}],
         "suggested":[{"id":"x","name":"x","description":"X","url":"https://github.com/o/x"}],
         "unknownField":1}
        """
        let result = try JSONDecoder().decode(SkillsResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.skills.map(\.name), ["anatomy", "pele"])
        XCTAssertFalse(result.skills[0].always)
        XCTAssertEqual(result.skills[0].sourceLine, "wheresryan22/anatomy at 1482e84")
        XCTAssertEqual(result.skills[0].sourceURL?.absoluteString, "https://github.com/wheresryan22/anatomy/tree/1482e84aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(result.skills[1].sourceLine, "Comes with Threadbear")
        XCTAssertNil(result.skills[1].sourceURL)
        XCTAssertEqual(result.suggested?.first?.id, "x")
    }
}
