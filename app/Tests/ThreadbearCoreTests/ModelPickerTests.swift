import XCTest
@testable import ThreadbearCore

final class ModelPickerTests: XCTestCase {
    private let efforts = ["low", "medium", "high", "xhigh", "max"]

    private var choices: [ModelChoice] {
        [
            ModelChoice(id: "opus", model: "claude-opus-5-5", title: "Opus 5.5", description: "For complex work", effortLevels: efforts),
            ModelChoice(id: "claude-fable-5-1[1m]", model: "claude-fable-5-1", title: "Fable 5.1", description: "For your toughest challenges", effortLevels: efforts),
            ModelChoice(id: "sonnet", model: "claude-sonnet-5-5", title: "Sonnet 5.5", description: "Most efficient", effortLevels: efforts),
            ModelChoice(id: "haiku", model: "claude-haiku-5-5", title: "Haiku 5.5", description: "Fastest", effortLevels: efforts),
            ModelChoice(id: "claude-haiku-4-5-20251001", model: "claude-haiku-4-5-20251001", title: "Haiku 4.5", description: "Fastest"),
            ModelChoice(id: "claude-opus-5", model: "claude-opus-5", title: "Opus 5", description: "Best for everyday", effortLevels: ["low", "high"]),
        ]
    }

    /// One column per provider, in the order the runner lists accounts,
    /// each with its accounts in that order.
    func testProvidersGroupAccountsInOrder() {
        let accounts = [
            Account(id: "claude-main", provider: "claude", title: "mike@example.com"),
            Account(id: "codex-main", provider: "codex", title: "mike@example.com"),
            Account(id: "claude-3", provider: "claude", title: "mike+3@example.com"),
        ]
        let providers = ModelPicker.providers(accounts)
        XCTAssertEqual(providers.map(\.id), ["claude", "codex"])
        XCTAssertEqual(providers.map(\.title), ["Claude", "Codex"])
        XCTAssertEqual(providers[0].accountIds, ["claude-main", "claude-3"])
        XCTAssertEqual(providers[1].accountIds, ["codex-main"])
        XCTAssertEqual(ModelPicker.providers([]).map(\.id), ["claude"], "nothing from the runner yet: still a Claude column")
        XCTAssertEqual(ModelPicker.providerTitle("gemini"), "Gemini")
    }

    /// Aliases and the default and chosen models are the main rows, each
    /// model once; dated and old ids are older; the default and the
    /// selection are marked.
    func testRowsSplitMainFromOlder() {
        let rows = ModelPicker.rows(choices: choices, defaultId: "claude-fable-5-1", selected: "opus")
        XCTAssertEqual(rows.filter { !$0.isOlder }.map(\.title), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"])
        XCTAssertEqual(rows.filter(\.isOlder).map(\.title), ["Haiku 4.5", "Opus 5"])
        XCTAssertEqual(rows.first(where: \.isDefault)?.title, "Fable 5.1")
        XCTAssertEqual(rows.first(where: \.isSelected)?.title, "Opus 5.5")
        XCTAssertEqual(rows.first?.subtitle, "For complex work")
    }

    /// The selection is found by the id the CLI runs it as, not only by
    /// what's sent, and a model the list doesn't know still gets a row.
    func testSelectionByEitherIdAndUnknownModels() {
        let byModel = ModelPicker.rows(choices: choices, defaultId: nil, selected: "claude-fable-5-1")
        XCTAssertEqual(byModel.first(where: \.isSelected)?.id, "claude-fable-5-1[1m]")
        let unknown = ModelPicker.rows(choices: choices, defaultId: nil, selected: "claude-sonnet-4")
        let extra = unknown.first(where: \.isSelected)
        XCTAssertEqual(extra?.title, "Sonnet 4")
        XCTAssertFalse(extra?.isOlder ?? true)
        XCTAssertEqual(unknown.count, choices.count + 1)
    }

    /// Before the runner has asked the CLI, the three aliases by name.
    func testRowsWithoutAListAreTheAliases() {
        let rows = ModelPicker.rows(choices: [], defaultId: nil, selected: "haiku")
        XCTAssertEqual(rows.map(\.title), ["Opus", "Sonnet", "Haiku"])
        XCTAssertEqual(rows.last?.isSelected, true)
        XCTAssertTrue(rows.allSatisfy { !$0.isOlder })
    }

    /// A search keeps any row that mentions it (title, id or description),
    /// older ones included and no longer set apart.
    func testSearchMatchesTitleIdAndDescriptionAcrossBothGroups() {
        let haiku = ModelPicker.rows(choices: choices, defaultId: nil, selected: nil, query: " haiku ")
        XCTAssertEqual(haiku.map(\.title), ["Haiku 5.5", "Haiku 4.5"])
        XCTAssertTrue(haiku.allSatisfy { !$0.isOlder })
        XCTAssertEqual(ModelPicker.rows(choices: choices, defaultId: nil, selected: nil, query: "toughest").map(\.title), ["Fable 5.1"])
        XCTAssertEqual(ModelPicker.rows(choices: choices, defaultId: nil, selected: nil, query: "20251001").map(\.title), ["Haiku 4.5"])
        XCTAssertEqual(ModelPicker.rows(choices: choices, defaultId: nil, selected: nil, query: "gpt"), [])
    }

    /// A pool with two logins lists Auto and each one. The model list stays
    /// in one order, and a model the login in front doesn't offer is dimmed.
    func testLoginChipsAndAModelTheLoginLacks() {
        let opus = ModelChoice(id: "opus", model: "claude-opus-5", title: "Opus")
        let fable = ModelChoice(id: "fable", model: "claude-fable-5", title: "Fable")
        let full = AccountUsage(windows: [UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 100)])
        let low = AccountUsage(windows: [
            UsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 4),
            UsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 75),
        ])
        let behrooz = Account(id: "claude-main", title: "behrooz@collabute.com", models: [opus], email: "behrooz@collabute.com", usage: low)
        let team = Account(id: "claude-1", title: "team@collabute.com", models: [opus, fable], email: "team@collabute.com", usage: full)
        let pool = Pool(id: "claude", title: "Claude", accountIds: ["claude-main", "claude-1"])
        let accounts = [behrooz, team]
        let chips = ModelPicker.loginChips(pool: pool, accounts: accounts, selected: "claude-1")
        XCTAssertEqual(chips.map(\.title), ["Auto", "behrooz", "team"])
        XCTAssertEqual(chips.map(\.subtitle), ["best room", "4% left", "100% left"])
        XCTAssertEqual(chips.map(\.isSelected), [false, false, true])
        XCTAssertEqual(chips[1].tone, .low)
        XCTAssertEqual(ModelPicker.loginChips(pool: Pool(id: "c", title: "C", accountIds: ["claude-1"]), accounts: accounts, selected: nil), [], "one login: no row")
        let onBehrooz = ModelPicker.accountRows(logins: accounts, accounts: accounts, focused: behrooz, defaultId: "opus", selected: "opus")
        XCTAssertEqual(onBehrooz.map(\.title), ["Opus", "Fable"])
        XCTAssertEqual(onBehrooz[0].subtitle, "On behrooz · 5-hour 4%")
        XCTAssertFalse(onBehrooz[0].unavailable)
        XCTAssertEqual(onBehrooz[1].subtitle, "Not on this login")
        XCTAssertTrue(onBehrooz[1].unavailable)
        let onTeam = ModelPicker.accountRows(logins: accounts, accounts: accounts, focused: team, defaultId: nil, selected: "opus")
        XCTAssertEqual(onTeam.map(\.title), ["Opus", "Fable"], "switching login doesn't reshuffle")
        XCTAssertEqual(onTeam[0].subtitle, "On team · week 100%")
        XCTAssertEqual(onTeam[1].subtitle, "On team")
        XCTAssertFalse(onTeam[1].unavailable)
    }

    /// Two logins can both call a row "opus" and run different models.
    /// Focusing one dims the other's, and the two rows don't share an id,
    /// so a click can't send the alias the other login runs as its own.
    func testSharedAliasStaysTwoRows() {
        let opus55 = ModelChoice(id: "opus", model: "claude-opus-5-5", title: "Opus 5.5")
        let opus5 = ModelChoice(id: "opus", model: "claude-opus-5", title: "Opus 5")
        let behrooz = Account(id: "claude-main", title: "behrooz@collabute.com", defaultModel: "claude-opus-5-5", models: [opus55], email: "behrooz@collabute.com")
        let team = Account(id: "claude-1", title: "team@collabute.com", defaultModel: "claude-opus-5", models: [opus5], email: "team@collabute.com")
        let accounts = [behrooz, team]
        let onTeam = ModelPicker.accountRows(logins: accounts, accounts: accounts, focused: team, defaultId: "claude-opus-5", selected: "claude-opus-5-5")
        XCTAssertEqual(onTeam.map(\.title), ["Opus 5.5", "Opus 5"])
        XCTAssertEqual(Set(onTeam.map(\.id)).count, 2)
        XCTAssertTrue(onTeam[0].unavailable)
        XCTAssertFalse(onTeam[0].isSelected)
        XCTAssertFalse(onTeam[0].isDefault)
        XCTAssertNotEqual(onTeam[0].id, "opus")
        XCTAssertFalse(onTeam[1].unavailable)
        XCTAssertEqual(onTeam[1].id, "claude-opus-5")
        XCTAssertTrue(onTeam[1].isDefault)
        XCTAssertFalse(onTeam[1].isSelected)
        let onBehrooz = ModelPicker.accountRows(logins: accounts, accounts: accounts, focused: behrooz, defaultId: "claude-opus-5-5", selected: "claude-opus-5-5")
        XCTAssertFalse(onBehrooz[0].unavailable)
        XCTAssertTrue(onBehrooz[0].isSelected)
        XCTAssertEqual(onBehrooz[0].id, "claude-opus-5-5")
        XCTAssertTrue(onBehrooz[1].unavailable)
        XCTAssertNotEqual(onBehrooz[1].id, onBehrooz[0].id)
        XCTAssertEqual(ModelPicker.modelMove("opus", from: behrooz, to: team), .clear)
        XCTAssertEqual(ModelPicker.modelMove("opus", from: behrooz, to: behrooz), .keep)
        let asFullId = Account(id: "claude-2", title: "other@collabute.com", models: [ModelChoice(id: "claude-opus-5-5", model: "claude-opus-5-5", title: "Opus 5.5")])
        XCTAssertEqual(ModelPicker.modelMove("opus", from: behrooz, to: asFullId), .set("claude-opus-5-5"))
        XCTAssertEqual(ModelPicker.modelMove("claude-fable-5", from: team, to: Account(id: "x", title: "x", models: [])), .keep, "no list yet: don't guess")
        let unknown = Account(id: "a", title: "a@collabute.com", models: [])
        let onlyOpus = Account(id: "b", title: "b@collabute.com", defaultModel: "claude-opus-5", models: [opus5])
        XCTAssertEqual(ModelPicker.modelMove("claude-fable-5", from: unknown, to: onlyOpus), .clear)
        XCTAssertEqual(ModelPicker.modelMove("opus", from: unknown, to: onlyOpus), .clear, "an unresolved alias is not this login's opus")
        XCTAssertEqual(ModelPicker.modelMove("claude-opus-5", from: unknown, to: onlyOpus), .set("opus"))
        XCTAssertEqual(ModelPicker.modelMove("claude-fable-5", from: nil, to: onlyOpus), .clear)
    }

    /// The levels come from the chosen model's row when the CLI gave any,
    /// else the usual five.
    func testEffortLevelsFollowTheModel() {
        XCTAssertEqual(ModelPicker.effortLevels(for: "claude-opus-5", in: choices), ["low", "high"])
        XCTAssertEqual(ModelPicker.effortLevels(for: "claude-haiku-4-5-20251001", in: choices), efforts, "no levels listed: the usual ones")
        XCTAssertEqual(ModelPicker.effortLevels(for: nil, in: choices), efforts)
        XCTAssertEqual(ModelPicker.effortLevels(for: "opus", in: []), efforts)
    }
}
