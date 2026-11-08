import AppKit
import ThreadbearCore

/// The Connectors panel's side of AppModel (docs/protocol.md,
/// "Connectors"). The runner asks the gateway; the app only asks the runner.
extension AppModel {
    /// After hello; `connectors.updated` keeps it current from then on.
    func loadConnectors() {
        fetchConnectors(refresh: false)
        loadOutsideAgents()
    }

    /// A fresh look at the gateway: the panel opening, or its refresh
    /// button. The runner skips the ask if it made one a moment ago.
    /// `shown`: the refresh button, whose icon spins and which says if the
    /// gateway's status couldn't be read. Opening the panel just logs it.
    func refreshConnectors(shown: Bool = false) {
        guard shown else { return fetchConnectors(refresh: true) }
        guard let client else { return }
        whileBusy(BusyKey.refreshConnectors) { [self] in
            do {
                connectors = try await client.connectorsStatus(refresh: true)
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                connectors = nil
                if connectorsShown { connectorsShown = false }
            } catch {
                show(error)
            }
        }
    }

    private func fetchConnectors(refresh: Bool) {
        guard let client else { return }
        Task {
            do {
                connectors = try await client.connectorsStatus(refresh: refresh)
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                // A runner from before Connectors: no icon, no panel.
                connectors = nil
                if connectorsShown { connectorsShown = false }
            } catch {
                AppLog.write("rpc", "connectors.status failed: \(error.localizedDescription)")
            }
        }
    }

    /// Opens a service's page on the gateway in the browser: its sign-in
    /// when it's signed out, else where it can be signed out or retried.
    func openConnect(_ service: ConnectorService) {
        guard let url = ConnectorsText.serviceURL(connectors, service) else { return }
        AppLog.write("connectors", "opening the gateway's page for \(service.id)")
        OpenGate.openWeb(url)
    }

    /// Opens the gateway's admin page, with every service on it.
    func openConnectorsAdmin() {
        guard let url = ConnectorsText.manageURL(connectors) else { return }
        AppLog.write("connectors", "opening the gateway's admin page")
        OpenGate.openWeb(url)
    }

    // MARK: Connectors setup (an experiment): Set up and Add a service

    /// Starts the thread that installs the gateway, and opens it. A second
    /// click while it's still open opens the same one.
    func setUpConnectors() {
        guard let client else { return }
        whileBusy(BusyKey.setUpConnectors) { [self] in
            do {
                let started = try await client.connectorsSetup()
                AppLog.write("connectors", "setup thread \(started.threadId)\(started.already == true ? " (already open)" : "")")
                select(started.threadId)
            } catch {
                show(error)
            }
        }
    }

    /// Starts the thread that adds a catalog service, or a server by its
    /// address, to the gateway, and opens it.
    func addConnector(id: String) {
        addConnector(key: id) { try await $0.connectorsAdd(id: id) }
    }

    func addConnector(url: String, title: String) {
        addConnector(key: url) { try await $0.connectorsAdd(url: url, title: title) }
    }

    private func addConnector(key: String, _ call: @escaping (RPCClient) async throws -> ConnectorsStarted) {
        guard let client else { return }
        whileBusy(BusyKey.addConnector(key)) { [self] in
            do {
                let started = try await call(client)
                select(started.threadId)
            } catch {
                show(error)
            }
        }
    }

    // MARK: Outside agents (an experiment): Grok Bot's keys

    func loadOutsideAgents() {
        guard let client else { return }
        Task {
            do {
                outsideAgents = try await client.agentsList()
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                outsideAgents = nil
            } catch {
                AppLog.write("rpc", "agents.list failed: \(error.localizedDescription)")
            }
        }
    }

    /// Makes a key and keeps it in agentJustConnected for the panel to
    /// show once. It's never logged.
    func connectAgent(name: String, write: Bool, readAll: Bool) {
        guard let client else { return }
        whileBusy(BusyKey.connectAgent) { [self] in
            do {
                let made = try await client.agentsConnect(name: name, write: write, readAll: readAll)
                agentJustConnected = made
                AppLog.write("agents", "made a \(made.key.scope) key for \(made.key.name)")
                outsideAgents = try? await client.agentsList()
            } catch {
                show(error)
            }
        }
    }

    /// Revokes one key, or every key with nil.
    func revokeAgent(_ id: String?) {
        guard let client else { return }
        whileBusy(BusyKey.revokeAgent(id)) { [self] in
            do {
                outsideAgents = try await client.agentsRevoke(id)
                if id == nil || agentJustConnected?.key.id == id { agentJustConnected = nil }
                flashDone(id == nil ? "Every agent key revoked" : "Key revoked")
            } catch {
                show(error)
            }
        }
    }
}
