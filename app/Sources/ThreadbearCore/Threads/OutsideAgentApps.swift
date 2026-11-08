import Foundation

/// The cloud apps the Connectors panel offers to connect to Threadbear's
/// /mcp (the Outside agents experiment, docs/protocol.md "Outside
/// agents"), each with what it needs and the boxes of its own form.
/// Checked against each one's own docs on 8 Nov 2026: Grok Bot and
/// Notion's Custom Agents take an https server with the key in an
/// Authorization header; Slackbot only takes servers that sign in with
/// OAuth or Slack's own identity, so it has no Make key. The key's name is
/// the app's name, which threads show as who started them and who sent a
/// message.
public struct OutsideAgentApp: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// Whether a Threadbear key works there today.
    public let canConnect: Bool
    /// What it needs first (plan, admin), one or two plain sentences.
    public let needs: String
    /// Where its form is, above the boxes.
    public let intro: String
    /// What to do once the form's filled in, below the boxes.
    public let outro: String
    /// Its own docs for adding an MCP server.
    public let docs: URL
    let auth: Bool

    /// The boxes of its form, in order, for a new key.
    public func form(url: String, secret: String) -> [ConnectorsText.AgentFormField] {
        guard auth else { return ConnectorsText.agentForm(url: url, secret: secret) }
        return [
            .init(label: "Name", value: "Threadbear", copies: true, tip: "Copy a name for the connection"),
            .init(label: "Server URL", value: url, copies: true, tip: "Copy the server address"),
            .init(label: "Auth", value: "A header", copies: false, tip: "Pick header-based auth, not OAuth"),
        ] + ConnectorsText.agentForm(url: url, secret: secret).filter { $0.label.hasPrefix("Header") }
    }

    public static let grokBot = OutsideAgentApp(
        id: "grok", name: "Grok Bot", canConnect: true,
        needs: "xAI's agent in the cloud. On a team plan, your admin's connector policy has to allow servers by address.",
        intro: "In Grok Bot, open Connect apps, then Add a custom connector, and fill in each box:",
        outro: "Save it, then ask Grok Bot to list your Threadbear threads. Its row here says Used just now once it works. If the key ever leaks, Revoke it and make a new one.",
        docs: URL(string: "https://docs.x.ai/grok-bot/computer-and-apps")!, auth: false)

    public static let notion = OutsideAgentApp(
        id: "notion", name: "Notion", canConnect: true,
        needs: "For Notion's Custom Agents, on the Business or Enterprise plan. A workspace admin turns on custom MCP servers first, in Settings > Connections.",
        intro: "In your Custom Agent's settings, open Tools & Access, then Add connection, then Custom MCP server, and fill in each box:",
        outro: "Connect it, then ask the agent to list your Threadbear threads. Its row here says Used just now once it works. If the key ever leaks, Revoke it and make a new one.",
        docs: URL(string: "https://www.notion.com/help/mcp-connections-for-custom-agents")!, auth: true)

    public static let slack = OutsideAgentApp(
        id: "slack", name: "Slack", canConnect: false,
        needs: "Slackbot only connects to servers that sign in with OAuth or with Slack's own sign-in, through a Slack app. It can't take a key, so Threadbear can't connect to it yet.",
        intro: "", outro: "",
        docs: URL(string: "https://docs.slack.dev/ai/slackbot-mcp-client/")!, auth: false)

    public static let all: [OutsideAgentApp] = [grokBot, notion, slack]

    public static func named(_ name: String) -> OutsideAgentApp? {
        all.first { $0.name == name }
    }

    /// The app a key was made for, by its name. A key named by hand (over
    /// the protocol, or before the list) gets Grok Bot's form under
    /// wording for any agent.
    public static func forKey(named name: String) -> OutsideAgentApp {
        if let app = named(name), app.canConnect { return app }
        return OutsideAgentApp(
            id: "other", name: name, canConnect: true, needs: "",
            intro: "In \(name), add a custom MCP server and fill in each box:",
            outro: "Save it, then ask it to list your Threadbear threads. Its row here says Used just now once it works. If the key ever leaks, Revoke it and make a new one.",
            docs: grokBot.docs, auth: false)
    }
}
