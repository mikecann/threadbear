import Foundation

/// What the composer's model picker shows, worked out here so the popover,
/// the automation's text form of it and the tests all read the same rows.
public enum ModelPicker {
    /// A column in the picker's rail: one provider (Claude, Codex, ...)
    /// and the accounts that run on it. Threads run on an account, so
    /// picking a model under another provider means moving to one of its
    /// accounts; `accountIds` keeps the runner's order, so the first is
    /// the one that gets used.
    public struct Provider: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var accountIds: [String]

        public init(id: String, title: String, accountIds: [String]) {
            self.id = id
            self.title = title
            self.accountIds = accountIds
        }
    }

    /// A button in the picker's rail: a pool (its providers' logos, its
    /// title, and its logins and best room under it) or, from a runner
    /// older than pools, a provider (its logo).
    public struct Column: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        /// "3 · 61%" under a pool's title.
        public var subtitle: String?
        /// An SF Symbol for a provider's icon, where the app has no logo
        /// for it.
        public var symbol: String?
        /// A pool's logins.
        public var logins: Int?
        /// The providers whose logos head a pool's button ("claude",
        /// "codex"), in the order its logins first name them.
        public var providers: [String]

        public init(id: String, title: String, subtitle: String? = nil, symbol: String? = nil, logins: Int? = nil, providers: [String] = []) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.symbol = symbol
            self.logins = logins
            self.providers = providers
        }
    }

    /// One provider's models in a column. A mixed pool has one per
    /// provider, each under its `title`; otherwise there's one, untitled.
    public struct Section: Sendable, Equatable, Identifiable {
        /// The provider.
        public var id: String
        public var title: String?
        public var rows: [Row]

        public init(id: String, title: String? = nil, rows: [Row]) {
            self.id = id
            self.title = title
            self.rows = rows
        }
    }

    /// One model in the list.
    public struct Row: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var subtitle: String?
        /// The account's (or the runner's) default: picking it leaves the
        /// thread on the default rather than pinning this model.
        public var isDefault: Bool
        public var isSelected: Bool
        /// A dated or superseded id, listed under "Older" rather than with
        /// the main rows.
        public var isOlder: Bool
        /// The login in front of the list doesn't offer this model.
        public var unavailable: Bool
        /// The model id this row runs as (`ModelChoice.model`). Empty
        /// means the same as `id`. Two logins can share a choice id
        /// ("opus") for different models, so matching goes by this.
        public var resolved: String

        public init(id: String, title: String, subtitle: String? = nil, isDefault: Bool = false, isSelected: Bool = false, isOlder: Bool = false, unavailable: Bool = false, resolved: String = "") {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.isDefault = isDefault
            self.isSelected = isSelected
            self.isOlder = isOlder
            self.unavailable = unavailable
            self.resolved = resolved
        }
    }

    /// One login in the row above the models, or Auto. Shown when the
    /// pool has more than one login.
    public struct LoginChip: Sendable, Equatable, Identifiable {
        public var id: String
        public var title: String
        public var subtitle: String
        public var help: String
        /// Under 25% left, or at its limit.
        public var tone: LoginTone
        public var isSelected: Bool

        public init(id: String, title: String, subtitle: String, help: String, tone: LoginTone = .normal, isSelected: Bool = false) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.help = help
            self.tone = tone
            self.isSelected = isSelected
        }
    }

    public enum LoginTone: Sendable, Equatable {
        case normal, low, blocked
    }

    /// The id of the Auto chip: the pool picks the login.
    public static let autoLogin = "auto"

    /// The providers in the rail, in the order the runner first lists an
    /// account for each. No accounts yet means a rail with just Claude, so
    /// the picker has somewhere to show the alias rows.
    public static func providers(_ accounts: [Account]) -> [Provider] {
        var providers: [Provider] = []
        for account in accounts {
            let id = account.provider.isEmpty ? "claude" : account.provider
            if let index = providers.firstIndex(where: { $0.id == id }) {
                providers[index].accountIds.append(account.id)
            } else {
                providers.append(Provider(id: id, title: providerTitle(id), accountIds: [account.id]))
            }
        }
        return providers.isEmpty ? [Provider(id: "claude", title: "Claude", accountIds: [])] : providers
    }

    /// How a provider id reads in the rail and its tooltip.
    public static func providerTitle(_ id: String) -> String {
        Providers.info(id).name
    }

    /// The SF Symbol that stands for a provider where the app has no logo
    /// for it (the picker draws Claude's and Codex's own, ProviderLogo),
    /// and for a pool's icon in the sidebar and Settings.
    public static func providerSymbol(_ id: String) -> String {
        switch id {
        case "claude": return "sparkle"
        case "codex": return "chevron.left.forwardslash.chevron.right"
        default: return "cpu"
        }
    }

    /// The three aliases the CLI always takes, offered until the runner has
    /// asked the account what it really lists.
    public static let aliases = ["opus", "sonnet", "haiku"]

    /// The rows for one account's list. For Claude the main rows are the
    /// aliases (a word) plus whatever the default and the chosen model are;
    /// dated and old full ids are `isOlder`. The CLI lists "opus" and the
    /// default both as the same model, so each model appears once. Codex
    /// ids are all dashed ("gpt-6.1-sol"), so for Codex every model is a
    /// main row, in `model/list`'s order. A chosen model the list doesn't
    /// know (set some other way) still gets a row, ticked. With a `query`,
    /// every row that mentions it is kept and the main/older split goes: a
    /// search is a search.
    ///
    /// Before the runner has the list, Claude offers the three aliases the
    /// CLI always takes; Codex offers just its default, since a Claude
    /// alias would be the wrong provider's model.
    public static func rows(choices: [ModelChoice], defaultId: String?, selected: String?, query: String = "", provider: String = "claude") -> [Row] {
        // Only Claude's CLI takes these aliases: anyone else lists its own.
        let codex = provider != "claude" && !provider.isEmpty
        let fallback: [ModelChoice] = codex
            ? [defaultId].compactMap { $0 }.filter { !$0.isEmpty }.map { ModelChoice(id: $0, model: $0, title: ComposerChips.model($0)) }
            : aliases.map { ModelChoice(id: $0, model: $0, title: ComposerChips.model($0)) }
        let known = choices.isEmpty ? fallback : choices
        var rows: [Row] = []
        var seenModels = Set<String>()
        func add(_ c: ModelChoice, older: Bool) {
            guard seenModels.insert(c.model).inserted else { return }
            let isDefault = matches(c, defaultId, in: known)
            rows.append(Row(id: c.id, title: c.title, subtitle: c.description, isDefault: isDefault, isSelected: matches(c, selected, in: known), isOlder: older, resolved: runsAs(c)))
        }
        let isMain = { (c: ModelChoice) -> Bool in
            codex || c.id.allSatisfy(\.isLetter) || matches(c, defaultId, in: known) || matches(c, selected, in: known)
        }
        for c in known where isMain(c) { add(c, older: false) }
        if let selected, !selected.isEmpty, !known.contains(where: { matches($0, selected, in: known) }) {
            rows.append(Row(id: selected, title: ComposerChips.model(selected), isSelected: true, resolved: selected))
        }
        for c in known where !isMain(c) { add(c, older: true) }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter { row in
            [row.title, row.id, row.subtitle ?? ""].contains { $0.lowercased().contains(needle) }
        }.map { row in
            var row = row
            row.isOlder = false
            return row
        }
    }

    /// What a choice runs as. An empty `model` is the choice id itself.
    static func runsAs(_ choice: ModelChoice) -> String {
        choice.model.isEmpty ? choice.id : choice.model
    }

    /// The model id `stored` runs as on this account. An alias ("opus")
    /// becomes that login's resolved model. No list yet, or not listed,
    /// comes back unchanged.
    public static func resolvedModel(_ stored: String?, on account: Account?) -> String? {
        guard let stored, !stored.isEmpty else { return nil }
        guard let account, let row = account.models.first(where: { $0.id == stored || $0.model == stored }) else { return stored }
        return runsAs(row)
    }

    /// What happens to an explicit model when a thread moves onto `to`.
    /// `.keep` leaves it: nothing was set, `to`'s list isn't known yet, or
    /// `to` already uses that choice id for the same model. `.clear` drops
    /// a model `to` doesn't list. `.set` is `to`'s choice id for that same
    /// resolved model. An alias is resolved on `from`. A list that hasn't
    /// come back for `from` does not keep a model `to` doesn't list, and an
    /// unresolved alias is not `to`'s own alias.
    public enum ModelMove: Equatable {
        case keep
        case clear
        case set(String)
    }

    public static func modelMove(_ explicit: String?, from: Account?, to: Account?) -> ModelMove {
        guard let explicit, !explicit.isEmpty, let to else { return .keep }
        if to.models.isEmpty { return .keep }
        if let from, let row = from.models.first(where: { $0.id == explicit || $0.model == explicit }) {
            let resolved = runsAs(row)
            guard let there = to.models.first(where: { runsAs($0) == resolved }) else { return .clear }
            return there.id == explicit ? .keep : .set(there.id)
        }
        // The login being left has a list, and this id isn't on it. `to`
        // still decides, matched by id or model.
        if from?.models.isEmpty == false {
            if let there = to.models.first(where: { $0.id == explicit || $0.model == explicit }) {
                return there.id == explicit ? .keep : .set(there.id)
            }
            return .clear
        }
        // No list yet on the login being left, so an alias can't be
        // resolved. Only the same resolved model counts.
        if let there = to.models.first(where: { runsAs($0) == explicit }) {
            return there.id == explicit ? .keep : .set(there.id)
        }
        return .clear
    }

    private static func matches(_ c: ModelChoice, _ id: String?, in choices: [ModelChoice]) -> Bool {
        guard let id, !id.isEmpty else { return false }
        if c.model == id || (c.model.isEmpty && c.id == id) { return true }
        guard c.id == id else { return false }
        // A shared alias is not a match: "opus" on two resolved models
        // would tick both. The caller passes the resolved model once it
        // knows which login's alias it is.
        return choices.filter { $0.id == id }.count <= 1
    }

    /// The effort levels the picker offers for a model: the CLI's list for
    /// it when known (Codex's go up to "ultra"), else the provider's usual
    /// ones. There's no "default" level any more: the picker remembers the
    /// last one chosen instead.
    public static func effortLevels(for model: String?, in choices: [ModelChoice], provider: String = "claude") -> [String] {
        if Providers.info(provider).effort == "none" { return [] }
        guard let model, let levels = ComposerChips.choice(for: model, in: choices)?.effortLevels, !levels.isEmpty else {
            return ComposerChips.effortLevels(provider: provider)
        }
        return levels
    }

    /// The level a thread with none chosen runs at, when it's known: the
    /// runner's default for the provider (new threads), else the account's
    /// own (Codex's `model_reasoning_effort`), else the model's.
    public static func impliedEffort(model: String?, choices: [ModelChoice], account: Account?, runnerDefault: String?) -> String? {
        if let runnerDefault, !runnerDefault.isEmpty { return runnerDefault }
        if let own = account?.defaultEffort, !own.isEmpty { return own }
        guard let model else { return nil }
        return ComposerChips.choice(for: model, in: choices)?.defaultEffort
    }

    /// Auto, then each login, for a pool with two or more. Empty for one
    /// login: the picker stays as it was. `selected` nil, or `autoLogin`,
    /// is Auto. A login's line is how much room it has left.
    public static func loginChips(pool: Pool, accounts: [Account], selected: String?, now: Date = Date()) -> [LoginChip] {
        let own = Pools.logins(pool, accounts: accounts)
        guard own.count >= 2 else { return [] }
        let auto = selected == nil || selected == autoLogin
        var chips = [LoginChip(id: autoLogin, title: "Auto", subtitle: "best room", help: "The pool picks the login", isSelected: auto)]
        for account in own {
            let name = AccountName.login(account.id, accounts: accounts)
            let blocked = account.usage?.blocked == true
            let room = AccountUsageText.room(account.usage)
            let subtitle: String
            let tone: LoginTone
            if blocked {
                subtitle = "Limit reached"
                tone = .blocked
            } else if let room {
                subtitle = AccountUsageText.percent(room) + " left"
                tone = room < AccountUsageText.chipWarning ? .low : .normal
            } else {
                subtitle = ""
                tone = .normal
            }
            chips.append(LoginChip(id: account.id, title: name, subtitle: subtitle, help: AccountUsageText.tooltip(account, fallback: name, now: now), tone: tone, isSelected: selected == account.id))
        }
        return chips
    }

    /// One provider's models across a pool's logins, in the same order
    /// whichever login is in front. A model the focused login doesn't
    /// offer is marked unavailable. With no list for that login yet, the
    /// rows stay as they are: dimming them would be a guess.
    ///
    /// A login is matched by the resolved model, never by a shared alias:
    /// two "opus" rows that run as different models stay two rows, and
    /// only the one this login runs is clickable. `selected` and
    /// `defaultId` should already be resolved on the account they belong
    /// to, or an alias ticks every row with that id.
    public static func accountRows(logins: [Account], accounts: [Account], focused: Account?, defaultId: String?, selected: String?, query: String = "", provider: String = "claude", now: Date = Date()) -> [Row] {
        let merged = mergedChoices(logins)
        let base = rows(choices: merged, defaultId: defaultId, selected: selected, query: query, provider: provider)
        guard let focused, !focused.models.isEmpty else { return uniqueRowIds(base) }
        let name = AccountName.login(focused.id, accounts: accounts)
        let detail = loginDetail(focused)
        let adjusted = base.map { row -> Row in
            var row = row
            let resolved = row.resolved.isEmpty ? row.id : row.resolved
            if let match = focused.models.first(where: { runsAs($0) == resolved }) {
                row.id = clickId(match, among: merged)
                row.resolved = runsAs(match)
                row.unavailable = false
                row.subtitle = "On " + name + (row.isSelected && !detail.isEmpty ? " · " + detail : "")
            } else {
                row.unavailable = true
                row.isSelected = false
                row.isDefault = false
                row.subtitle = "Not on this login"
                if resolved != row.id { row.id = resolved }
            }
            return row
        }
        return uniqueRowIds(adjusted)
    }

    /// The id a click sends. A choice id shared by two resolved models
    /// ("opus") would run as whichever login is in front, so the click
    /// sends the resolved model instead.
    private static func clickId(_ match: ModelChoice, among merged: [ModelChoice]) -> String {
        let resolved = runsAs(match)
        let shared = merged.contains { $0.id == match.id && runsAs($0) != resolved }
        return shared ? resolved : match.id
    }

    /// ForEach identity is the row id, and a click sends it too. Two
    /// rows that share an alias get distinct ids; a clickable row keeps
    /// the id it already has.
    private static func uniqueRowIds(_ rows: [Row]) -> [Row] {
        var seen = Set<String>()
        let claimed = Set(rows.filter { !$0.unavailable }.map(\.id))
        return rows.map { row in
            var row = row
            if seen.contains(row.id) || (row.unavailable && claimed.contains(row.id)) {
                let resolved = row.resolved.isEmpty ? row.id : row.resolved
                var candidate = resolved
                var n = 2
                while seen.contains(candidate) || claimed.contains(candidate) {
                    candidate = "\(resolved)#\(n)"
                    n += 1
                }
                row.id = candidate
            }
            seen.insert(row.id)
            return row
        }
    }

    /// The pool's models in login order, each model once. The first login
    /// to list it keeps the row, so switching login doesn't reshuffle.
    static func mergedChoices(_ logins: [Account]) -> [ModelChoice] {
        var byKey: [String: ModelChoice] = [:]
        var order: [String] = []
        for account in logins {
            for choice in account.models {
                let key = choice.model.isEmpty ? choice.id : choice.model
                if byKey[key] == nil {
                    order.append(key)
                    byKey[key] = choice
                }
            }
        }
        return order.compactMap { byKey[$0] }
    }

    /// "5-hour 4%" or "week 100%", the tighter window, for the chosen
    /// model's line. Empty when nothing is known.
    static func loginDetail(_ account: Account) -> String {
        if account.usage?.blocked == true { return "limit reached" }
        guard let window = AccountUsageText.tightest(account.usage) else { return "" }
        let name: String
        switch window.kind {
        case "five_hour": name = "5-hour"
        case "weekly": name = "week"
        default: name = window.title.lowercased()
        }
        return name + " " + AccountUsageText.percent(window.remainingPercent)
    }
}
