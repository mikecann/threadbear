import XCTest
@testable import ThreadbearCore

/// Profiles: the runner's profiles.json read, the app opening on the
/// profile last switched to, and each profile's settings kept apart.
final class ProfilesTests: XCTestCase {
    private var base: URL!
    private var work: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("profiles-\(UUID().uuidString)", isDirectory: true)
        work = base.appendingPathComponent("Profiles/work", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try #"{"port": 8797}"#.write(to: base.appendingPathComponent("runner.json"), atomically: true, encoding: .utf8)
        try #"{"port": 8798, "profile": {"id": "work", "name": "Work"}}"#.write(to: work.appendingPathComponent("runner.json"), atomically: true, encoding: .utf8)
        let list = #"{"profiles":[{"id":"work","name":"Work","home":"\#(work.path)","port":8798,"label":"com.mikerosoft.threadbear.runner.work","createdAt":"2026-11-07T00:00:00Z"}]}"#
        try list.write(to: base.appendingPathComponent("profiles.json"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    func testPersonalComesFirstThenTheList() {
        let all = Profiles.all(base: base)
        XCTAssertEqual(all.map(\.id), ["personal", "work"])
        XCTAssertEqual(all[0].label, RunnerConfig.launchdLabel)
        XCTAssertEqual(all[1].label, "com.mikerosoft.threadbear.runner.work")
        XCTAssertEqual(all[1].port, 8798)
        XCTAssertEqual(Profiles.entry(for: work, in: all)?.id, "work")
        XCTAssertEqual(Profiles.entry(for: base, in: all)?.id, "personal")
        XCTAssertNil(Profiles.entry(for: URL(fileURLWithPath: "/tmp/mock"), in: all))
    }

    func testNoListIsJustPersonal() {
        try? FileManager.default.removeItem(at: base.appendingPathComponent("profiles.json"))
        XCTAssertEqual(Profiles.all(base: base).map(\.id), ["personal"])
    }

    func testTheAppOpensOnTheSavedProfileOnlyWhileItsListed() {
        let all = { Profiles.all(base: self.base) }
        XCTAssertEqual(RunnerConfig.dataDir(arguments: [], environment: [:], savedProfileHome: work.path, profiles: all).path, work.path)
        // --data-dir and the environment still come first (the mock, tests).
        XCTAssertEqual(RunnerConfig.dataDir(arguments: ["x", "--data-dir", "/tmp/mock"], environment: [:], savedProfileHome: work.path, profiles: all).path, "/tmp/mock")
        // A profile taken off the list: back to Personal's folder.
        XCTAssertEqual(RunnerConfig.dataDir(arguments: [], environment: [:], savedProfileHome: "/tmp/gone", profiles: all), RunnerConfig.defaultDataDir)
        XCTAssertEqual(RunnerConfig.dataDir(arguments: [], environment: [:], savedProfileHome: nil, profiles: all), RunnerConfig.defaultDataDir)
    }

    func testEachProfileKeepsItsOwnSettingsAndPersonalKeepsTheOldNames() {
        XCTAssertEqual(Profiles.scoped("lastAccountId", profileId: nil), "lastAccountId")
        XCTAssertEqual(Profiles.scoped("lastAccountId", profileId: "personal"), "lastAccountId")
        XCTAssertEqual(Profiles.scoped("lastAccountId", profileId: "work"), "profile.work.lastAccountId")
    }

    func testInstalledRunnersLabelsAndTheSharedFolder() {
        let all = Profiles.all(base: base)
        XCTAssertTrue(RunnerConfig.isInstalled(dataDir: work, profiles: all))
        XCTAssertFalse(RunnerConfig.isInstalled(dataDir: URL(fileURLWithPath: "/tmp/mock"), profiles: all))
        XCTAssertEqual(RunnerConfig.launchdLabel(dataDir: work, profiles: all), "com.mikerosoft.threadbear.runner.work")
        XCTAssertEqual(RunnerConfig.launchdLabel(dataDir: URL(fileURLWithPath: "/tmp/mock"), profiles: all), RunnerConfig.launchdLabel)
        // Shortcuts are shared: a profile's live in Personal's folder.
        XCTAssertEqual(RunnerConfig.sharedDir(dataDir: work, profiles: all), RunnerConfig.defaultDataDir)
        XCTAssertEqual(RunnerConfig.sharedDir(dataDir: URL(fileURLWithPath: "/tmp/mock"), profiles: all).path, "/tmp/mock")
    }

    func testColours() {
        let all = Profiles.all(base: base)
        XCTAssertNil(Profiles.colour(of: all[0], picked: nil, index: 0), "Personal has none unless picked")
        XCTAssertEqual(Profiles.colour(of: all[0], picked: "green", index: 0), "green")
        XCTAssertEqual(Profiles.colour(of: all[1], picked: nil, index: 1), "orange")
        XCTAssertEqual(Profiles.colour(of: all[1], picked: "nope", index: 1), "orange")
    }
}
