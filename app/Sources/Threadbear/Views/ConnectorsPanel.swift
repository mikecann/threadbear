import AppKit
import SwiftUI
import ThreadbearCore

/// The activity bar's Connectors icon: Mike's Connectors gateway's
/// services (docs/protocol.md, "Connectors"). Only once the runner has
/// answered `connectors.status`. The accent dot while a service is signed
/// out, as only Mike can sign it back in; a grey one while the gateway
/// can't be reached or a service is having trouble, which usually sorts
/// itself out (as Updates' dots go).
struct ConnectorsActivityButton: View {
    @Environment(AppModel.self) private var app
    @AppStorage(ConnectorsText.Hidden.defaultsKey) private var hiddenRaw = ""

    var body: some View {
        let status = app.connectors
        let hidden = ConnectorsText.Hidden.decode(hiddenRaw)
        ActivityButton(symbol: WindowDock.connectorsSymbol, title: "Connectors",
                       tip: ConnectorsText.tooltip(status, hiding: hidden),
                       dot: ConnectorsText.needsYou(status, hiding: hidden), quietDot: ConnectorsText.quiet(status, hiding: hidden),
                       active: app.connectorsShown) {
            app.connectorsShown.toggle()
        }
    }
}

/// Each gateway service with its state, and Connect for one that's signed
/// out, which opens its sign-in page in the browser. The header's arrow
/// opens the gateway's admin page and a signed-in row's opens that
/// service's page, where it can be signed out (30 Oct: Mike wanted to edit
/// connectors from here, and the gateway already has the pages for it). A panel in the dock,
/// beside Usage and Updates. It asks the runner for a fresh look when it
/// opens; the runner also looks every few minutes by itself.
struct ConnectorsPanel: View {
    @Environment(AppModel.self) private var app
    @State private var aboutShown = false
    @AppStorage(ConnectorsText.Hidden.defaultsKey) private var hiddenRaw = ""

    var body: some View {
        let status = app.connectors
        let hidden = ConnectorsText.Hidden.decode(hiddenRaw)
        ScrollView {
            VStack(alignment: .leading, spacing: zoomed(12)) {
                HStack(alignment: .firstTextBaseline, spacing: zoomed(6)) {
                    // Where they live ("bruce"), rather than a label.
                    Text(ConnectorsText.host(status) ?? "Gateway")
                        .font(.system(size: zoomed(11), weight: .medium))
                        .foregroundStyle(.tertiary)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    if ConnectorsText.manageURL(status) != nil {
                        Button { app.openConnectorsAdmin() } label: {
                            Image(systemName: "arrow.up.forward.square").font(.system(size: zoomed(11)))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .tip("Manage connectors on \(ConnectorsText.host(status) ?? "the gateway")")
                    }
                    Button { app.refreshConnectors(shown: true) } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .busy(app.isBusy(BusyKey.refreshConnectors))
                    .foregroundStyle(.secondary)
                    .tip("Check the gateway again now")
                    Button { aboutShown.toggle() } label: {
                        Image(systemName: "info.circle").font(.system(size: zoomed(11)))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .tip("What this panel shows")
                    .popover(isPresented: $aboutShown, arrowEdge: .bottom) { ConnectorsAbout(status: status) }
                }
                if status?.canSetUp == true {
                    ConnectorsSetUpCard()
                } else if let line = ConnectorsText.emptyLine(status), status?.services.isEmpty ?? true {
                    Text(line)
                        .font(.system(size: zoomed(12)))
                        .foregroundStyle(status?.state == "unreachable" ? .primary : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(ConnectorsText.shown(status?.services ?? [], hiding: hidden)) { service in
                    ConnectorRow(service: service)
                }
                if let status, status.state == "ok", !status.catalog.isEmpty {
                    Divider().padding(.vertical, zoomed(2))
                    AddServiceSection(catalog: ConnectorsText.shown(status.catalog, hiding: hidden))
                }
                // Hiding Connect an agent hides the section, unless a key
                // is live: its Revoke is never out of reach.
                if let agents = app.outsideAgents, agents.on,
                   !hidden.contains(ConnectorsText.Hidden.grokBot) || !agents.keys.isEmpty {
                    Divider().padding(.vertical, zoomed(2))
                    OutsideAgentsSection(agents: agents, offerHidden: hidden.contains(ConnectorsText.Hidden.grokBot))
                }
                ShowHiddenMenu(items: ConnectorsText.Hidden.items(hidden, status: status, agents: app.outsideAgents))
            }
            .padding(zoomed(16))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            app.refreshConnectors()
            app.loadOutsideAgents()
        }
        // A key is shown once: closing the panel puts it away for good.
        .onDisappear { app.agentJustConnected = nil }
    }
}

private struct ConnectorRow: View {
    @Environment(AppModel.self) private var app
    let service: ConnectorService
    @State private var hovered = false

    var body: some View {
        let signedOut = service.state == "signed_out"
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            // A small mark for the state: filled when signed in, the
            // accent only where Mike has something to do.
            Circle()
                .fill(markColor)
                .frame(width: zoomed(6), height: zoomed(6))
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - zoomed(1) }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: zoomed(2)) {
                Text(service.title)
                    .font(.system(size: zoomed(12), weight: signedOut ? .medium : .regular))
                    .lineLimit(1)
                Text(ConnectorsText.stateLine(service))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.secondary)
                if let message = service.message, service.state != "connected" {
                    Text(message)
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.tertiary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: zoomed(6))
            if let title = ConnectorsText.buttonTitle(service) {
                Button(title) { app.openConnect(service) }
                    .controlSize(.small)
                    .tip("Open \(service.title)'s sign-in page in your browser")
            } else if ConnectorsText.serviceURL(app.connectors, service) != nil {
                // A signed-in service has nothing to press, but Mike may
                // want to sign it out or switch accounts: its page on the
                // gateway has Disconnect. Quiet until the row's hovered.
                Button { app.openConnect(service) } label: {
                    Image(systemName: "arrow.up.forward").font(.system(size: zoomed(11)))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .opacity(hovered ? 1 : 0.35)
                .tip("Open \(service.title)'s page on \(ConnectorsText.host(app.connectors) ?? "the gateway") to sign out or reconnect")
            }
            HideButton(id: ConnectorsText.Hidden.service(service.id), shown: hovered,
                       tip: "Hide \(service.title) from this panel. Agents can still use it; the + below brings it back.")
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
    }

    private var markColor: Color {
        switch service.state {
        case "signed_out": return .accentColor
        case "connected": return Color.secondary.opacity(0.7)
        case "error": return .orange
        default: return Color.secondary.opacity(0.3)
        }
    }
}

/// The ⓘ: where the services come from, and the claude.ai ones this
/// panel doesn't cover.
private struct ConnectorsAbout: View {
    let status: ConnectorsStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("These are the services your agents get from the Connectors gateway\(host.map { " on \($0)" } ?? ""). Connect opens a service's sign-in page in your browser. The arrows open the gateway's own pages, to sign a service out or reconnect it.")
            Text("The runner checks every few minutes and when this panel opens. When an agent runs into a service that needs signing in, it asks you with a link to the page.")
            Text("A row's × hides it from this panel only; agents can still use the service. The + hidden menu at the bottom brings it back.")
            Text("claude.ai's own connectors are signed in on claude.ai, for each login.")
            if let checked = status?.checkedAt {
                Text("Last checked \(checked.formatted(date: .omitted, time: .shortened)).")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.system(size: zoomed(12)))
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: zoomed(280), alignment: .leading)
        .padding(zoomed(14))
    }

    private var host: String? { ConnectorsText.host(status) }
}

// MARK: Connectors setup (an experiment)

/// No gateway yet: what one is for, and Set up, which starts a thread that
/// installs plugbear on this Mac (runner/src/connectors-catalog.ts).
private struct ConnectorsSetUpCard: View {
    @Environment(AppModel.self) private var app
    @State private var aboutShown = false

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("Share one sign-in for Notion, Slack and other services with every login and agent, with a check before anything is sent.")
                .font(.system(size: zoomed(12)))
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: zoomed(6)) {
                Button("Set up") { app.setUpConnectors() }
                    .controlSize(.small)
                    .busy(app.isBusy(BusyKey.setUpConnectors))
                    .tip("Start a thread that installs the Connectors gateway on this Mac")
                Button { aboutShown.toggle() } label: {
                    Image(systemName: "info.circle").font(.system(size: zoomed(11)))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .tip("What Set up does")
                .popover(isPresented: $aboutShown, arrowEdge: .bottom) {
                    InfoText(lines: [
                        "A thread installs plugbear, a small gateway of your own, on this Mac. It listens only on this Mac, at 127.0.0.1:8795.",
                        "It wires each of your logins to it, so a service signed in once works for all of them, and Codex and the Grok CLI too.",
                        "Sends, posts and deletes wait for your OK on its approval page, and it keeps a log of every call. Sign-ins stay in the gateway, never in Threadbear.",
                        "The thread asks you before anything that needs a password, and says what it changed.",
                    ])
                }
            }
        }
    }
}

/// Services the gateway doesn't have yet, each with Add, and any other MCP
/// server by its address. Each Add starts a short thread.
private struct AddServiceSection: View {
    @Environment(AppModel.self) private var app
    let catalog: [ConnectorCatalogEntry]
    @State private var otherShown = false
    @State private var url = ""
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(10)) {
            Text("Add a service")
                .font(.system(size: zoomed(11), weight: .medium))
                .foregroundStyle(.tertiary)
                .accessibilityAddTraits(.isHeader)
            ForEach(catalog) { entry in
                CatalogRow(entry: entry)
            }
            if otherShown {
                VStack(alignment: .leading, spacing: zoomed(6)) {
                    TextField("https://example.com/mcp", text: $url)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                        .tip("The server's https address")
                    TextField("Name", text: $name)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                        .tip("What to call it")
                    HStack(spacing: zoomed(6)) {
                        Button("Add") {
                            app.addConnector(url: url.trimmingCharacters(in: .whitespaces), title: name)
                        }
                        .controlSize(.small)
                        .disabled(!url.lowercased().hasPrefix("https://"))
                        .busy(app.isBusy(BusyKey.addConnector(url.trimmingCharacters(in: .whitespaces))))
                        .tip("Start a thread that adds this server to the gateway")
                        Button("Cancel") { otherShown = false }
                            .controlSize(.small)
                            .tip("Don't add a server")
                    }
                    Text("Only public https servers. Anything else is refused before a thread starts.")
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Button("Other MCP server...") { otherShown = true }
                    .buttonStyle(.link)
                    .font(.system(size: zoomed(12)))
                    .tip("Add any MCP server by its https address")
            }
        }
    }
}

private struct CatalogRow: View {
    @Environment(AppModel.self) private var app
    let entry: ConnectorCatalogEntry
    @State private var noteShown = false
    @State private var hovered = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            VStack(alignment: .leading, spacing: zoomed(2)) {
                Text(entry.title)
                    .font(.system(size: zoomed(12)))
                    .lineLimit(1)
                if !entry.blurb.isEmpty {
                    Text(entry.blurb)
                        .font(.system(size: zoomed(11)))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: zoomed(6))
            if let note = entry.setupNote {
                Button { noteShown.toggle() } label: {
                    Image(systemName: "info.circle").font(.system(size: zoomed(11)))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .tip("What \(entry.title) needs first")
                .popover(isPresented: $noteShown, arrowEdge: .bottom) { InfoText(lines: [note]) }
            }
            Button("Add") { app.addConnector(id: entry.id) }
                .controlSize(.small)
                .busy(app.isBusy(BusyKey.addConnector(entry.id)))
                .tip("Start a thread that adds \(entry.title) to the gateway")
            HideButton(id: ConnectorsText.Hidden.catalog(entry.id), shown: hovered,
                       tip: "Hide the \(entry.title) suggestion. The + below brings it back.")
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
    }
}

// MARK: Outside agents (an experiment)

/// each key with what it may do and Revoke, and Connect an agent, which
/// picks the app (Grok Bot, Notion, Slack: OutsideAgentApp), makes a key
/// named for it and shows it once.
/// makes a key and shows it once.
private struct OutsideAgentsSection: View {
    @Environment(AppModel.self) private var app
    let agents: AgentsList
    /// Mike hid Connect an agent; the section is only here for live keys.
    var offerHidden = false
    @State private var picked = OutsideAgentApp.grokBot.id
    @State private var write = false
    @State private var offerHovered = false
    @State private var readAll = false
    @State private var formShown = false

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(10)) {
            Text("Agents that use Threadbear")
                .font(.system(size: zoomed(11), weight: .medium))
                .foregroundStyle(.tertiary)
                .accessibilityAddTraits(.isHeader)
            if let reason = agents.reason {
                Text(reason)
                    .font(.system(size: zoomed(12)))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(agents.keys) { key in
                AgentKeyRow(key: key)
            }
            if let made = app.agentJustConnected {
                NewKeyBox(made: made)
            } else if agents.reason == nil, !offerHidden {
                if formShown {
                    ConnectAgentForm(picked: $picked, write: $write, readAll: $readAll) { formShown = false }
                } else {
                    HStack(spacing: zoomed(6)) {
                        Button("Connect an agent") { formShown = true }
                            .controlSize(.small)
                            .tip("Let Grok Bot, Notion or another agent list, read and start threads here through your backend")
                        Spacer(minLength: 0)
                        HideButton(id: ConnectorsText.Hidden.grokBot, shown: offerHovered,
                                   tip: "Hide Connect an agent. The + below brings it back.")
                    }
                    .contentShape(Rectangle())
                    .onHover { offerHovered = $0 }
                }
            }
            if agents.keys.count > 1 {
                Button("Revoke all") { app.revokeAgent(nil) }
                    .buttonStyle(.link)
                    .font(.system(size: zoomed(11)))
                    .busy(app.isBusy(BusyKey.revokeAgent(nil)))
                    .tip("End every agent's key now")
            }
        }
        .onChange(of: app.agentJustConnected == nil) { _, gone in if !gone { formShown = false } }
    }
}

/// Which app, what it needs, its own guide, and what the key may do.
/// Slack can't take a key, so it says why and has no Make key (8 Nov).
private struct ConnectAgentForm: View {
    @Environment(AppModel.self) private var app
    @Binding var picked: String
    @Binding var write: Bool
    @Binding var readAll: Bool
    let close: () -> Void

    var body: some View {
        let agent = OutsideAgentApp.all.first { $0.id == picked } ?? .grokBot
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Picker("Agent", selection: $picked) {
                ForEach(OutsideAgentApp.all) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .tip("Which app to connect to Threadbear")
            Text(agent.needs)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("\(agent.name)'s guide") { OpenGate.openWeb(agent.docs) }
                .buttonStyle(.link)
                .font(.system(size: zoomed(11)))
                .tip("Open \(agent.name)'s own page on adding an MCP server")
            if agent.canConnect {
                Toggle("Can start Ask threads and message them", isOn: $write)
                    .toggleStyle(.checkbox)
                    .tip("Threads it starts always ask you before any tool runs")
                Toggle("Can read all my threads", isOn: $readAll)
                    .toggleStyle(.checkbox)
                    .tip("Without this it reads only threads it started. Archived threads are never shown.")
            }
            HStack(spacing: zoomed(6)) {
                if agent.canConnect {
                    Button("Make key") { app.connectAgent(name: agent.name, write: write, readAll: readAll) }
                        .controlSize(.small)
                        .busy(app.isBusy(BusyKey.connectAgent))
                        .tip("Make a key for \(agent.name), shown once")
                }
                Button(agent.canConnect ? "Cancel" : "Close") { close() }
                    .controlSize(.small)
                    .tip(agent.canConnect ? "Don't make a key" : "Put this away")
            }
        }
        .font(.system(size: zoomed(12)))
    }
}

private struct AgentKeyRow: View {
    @Environment(AppModel.self) private var app
    let key: AgentKey

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: zoomed(8)) {
            VStack(alignment: .leading, spacing: zoomed(2)) {
                Text(key.name)
                    .font(.system(size: zoomed(12)))
                    .lineLimit(1)
                Text(ConnectorsText.scopeLine(key))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.secondary)
                Text(ConnectorsText.lastUsed(key))
                    .font(.system(size: zoomed(11)))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: zoomed(6))
            Button("Revoke") { app.revokeAgent(key.id) }
                .controlSize(.small)
                .busy(app.isBusy(BusyKey.revokeAgent(key.id)))
                .tip("End this key: its next call is refused")
        }
    }
}

/// A new key, once, as the boxes of its app's form (Grok Bot's "Add a
/// custom connector", Notion's Custom MCP server), each with what to put
/// there. The key is copied, never shown.
private struct NewKeyBox: View {
    @Environment(AppModel.self) private var app
    let made: AgentConnected

    var body: some View {
        let agent = OutsideAgentApp.forKey(named: made.key.name)
        VStack(alignment: .leading, spacing: zoomed(8)) {
            Text("Copy these now. The key can't be copied again once this panel closes.")
                .font(.system(size: zoomed(12), weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            Text(agent.intro)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(agent.form(url: made.url, secret: made.secret), id: \.label) { field in
                FormLine(field: field)
            }
            Text(agent.outro)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Done") { app.agentJustConnected = nil }
                .controlSize(.small)
                .tip("Put the key away")
        }
        .padding(zoomed(10))
        .background(RoundedRectangle(cornerRadius: zoomed(6)).fill(Color.secondary.opacity(0.08)))
    }
}

/// One box of an agent's form: its name, what goes in it, and a copy
/// button for what's pasted.
private struct FormLine: View {
    @Environment(AppModel.self) private var app
    let field: ConnectorsText.AgentFormField

    var body: some View {
        HStack(spacing: zoomed(6)) {
            Text(field.label)
                .font(.system(size: zoomed(11)))
                .foregroundStyle(.secondary)
                .frame(width: zoomed(84), alignment: .leading)
            Text(field.shown)
                .font(.system(size: zoomed(11), design: field.copies ? .monospaced : .default))
                .foregroundStyle(field.copies ? .primary : .secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .tip(field.tip)
            Spacer(minLength: 0)
            if field.copies {
                Button { app.copyToPasteboard(field.value) } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: zoomed(11)))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .tip(field.tip)
            }
        }
    }
}

// MARK: Hiding rows

/// The × at the end of a row: hides it from this panel only (nothing is
/// signed out or removed). Shown while the row's hovered, and always there
/// for VoiceOver and the keyboard.
private struct HideButton: View {
    let id: String
    let shown: Bool
    let tip: String
    @AppStorage(ConnectorsText.Hidden.defaultsKey) private var hiddenRaw = ""
    @FocusState private var focused: Bool

    var body: some View {
        Button {
            var hidden = ConnectorsText.Hidden.decode(hiddenRaw)
            hidden.insert(id)
            hiddenRaw = ConnectorsText.Hidden.encode(hidden)
        } label: {
            Image(systemName: "xmark").font(.system(size: zoomed(9), weight: .semibold))
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.tertiary)
        .focused($focused)
        .opacity(shown || focused ? 1 : 0)
        .accessibilityLabel("Hide")
        .tip(tip)
    }
}

/// The + under everything once something's hidden: each hidden row, to
/// show it again, and Show all.
private struct ShowHiddenMenu: View {
    let items: [ConnectorsText.Hidden.Item]
    @AppStorage(ConnectorsText.Hidden.defaultsKey) private var hiddenRaw = ""

    var body: some View {
        if !items.isEmpty {
            IconMenu {
                ForEach(items) { item in
                    Button("Show \(item.title)") { show([item.id]) }
                }
                if items.count > 1 {
                    Divider()
                    Button("Show all") { show(items.map(\.id)) }
                }
            } label: {
                Label(items.count == 1 ? "1 hidden" : "\(items.count) hidden", systemImage: "plus.circle")
                    .font(.system(size: zoomed(11)))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .foregroundStyle(.secondary)
            .tip("Bring back a connector you hid")
            .padding(.top, zoomed(2))
        }
    }

    private func show(_ ids: [String]) {
        var hidden = ConnectorsText.Hidden.decode(hiddenRaw)
        hidden.subtract(ids)
        hiddenRaw = ConnectorsText.Hidden.encode(hidden)
    }
}

private struct InfoText: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: zoomed(8)) {
            ForEach(lines, id: \.self) { Text($0) }
        }
        .font(.system(size: zoomed(12)))
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: zoomed(280), alignment: .leading)
        .padding(zoomed(14))
    }
}
