import AppKit
import SwiftUI
import ThreadbearCore

/// The profile this app is showing (Profiles in ThreadbearCore): the one
/// whose folder it opened on, fixed for the life of the process, since
/// switching opens the app again on the other folder. A dev or scripted
/// app on the mock or a dev runner is on no profile.
@MainActor
enum AppProfile {
    /// Every profile, Personal first, as the app started. A scripted app can
    /// be given a made-up list (`--profiles-list <folder with profiles.json>`)
    /// to draw the switcher; it never reads the real one's runners.
    static let all: [ProfileEntry] = {
        let args = CommandLine.arguments
        if args.contains("--automation"), let i = args.firstIndex(of: "--profiles-list"), i + 1 < args.count {
            return Profiles.all(base: URL(fileURLWithPath: args[i + 1], isDirectory: true))
        }
        return Profiles.all()
    }()
    /// This app's profile, if its folder is one.
    static let current: ProfileEntry? = Profiles.entry(for: RunnerConfig.dataDir(), in: all)

    /// More than one profile: only then is there a switcher and a colour.
    static var hasSeveral: Bool { all.count > 1 }

    /// A setting's key in this profile (Personal's keep their old names).
    nonisolated static func key(_ key: String) -> String {
        MainActor.assumeIsolated { Profiles.scoped(key, profileId: current?.id) }
    }

    private static func colourKey(_ id: String) -> String { "profileColour.\(id)" }

    /// A profile's colour name: picked in Settings > Profiles, else its place in the list.
    static func colourName(_ entry: ProfileEntry) -> String? {
        Profiles.colour(of: entry, picked: UserDefaults.standard.string(forKey: colourKey(entry.id)), index: all.firstIndex(of: entry) ?? 0)
    }

    static func setColour(_ name: String?, for entry: ProfileEntry) {
        UserDefaults.standard.set(name, forKey: colourKey(entry.id))
    }

    static func colour(_ entry: ProfileEntry) -> Color? {
        colourName(entry).map(swatch)
    }

    static func swatch(_ name: String) -> Color {
        switch name {
        case "blue": .blue
        case "orange": .orange
        case "green": .green
        case "purple": .purple
        case "pink": .pink
        case "teal": .teal
        case "red": .red
        case "yellow": .yellow
        default: .accentColor
        }
    }

    /// Whether this app can switch: the installed app, opened on its own
    /// (a debug app's --data-dir would be lost, and must never reach the
    /// real runners).
    static var canSwitch: Bool {
        current != nil && !CommandLine.arguments.contains("--data-dir") && ProcessInfo.processInfo.environment["THREADBEAR_DATA_DIR"] == nil
            && !CommandLine.arguments.contains("--automation")
    }

    /// Opens the app again on `entry`'s folder. Anything typed in a file is
    /// saved or asked about first, and the window is handed to the new app
    /// as an update's is, so it never goes away.
    static func switchTo(_ entry: ProfileEntry, app: AppModel) {
        guard canSwitch, entry != current else { return }
        guard EditedFiles.shared.mayLeave(nil) else { return }
        NotesStore.shared.flush()
        UserDefaults.standard.set(entry.isPersonal ? nil : entry.home, forKey: Profiles.savedHomeKey)
        UserDefaults.standard.synchronize()
        AppLog.write("profiles", "switching to \(entry.id)")
        let bundle = Bundle.main.bundleURL
        let classic = {
            AppUpdate.relaunchAfterExit(bundle)
            NSApp.terminate(nil)
        }
        if let window = Handover.windowToHandOver() {
            Handover.shared.handOver(to: bundle, window: window, app: app, fallback: classic)
        } else {
            classic()
        }
    }
}

/// The profile menu at the top of the sidebar: this profile's colour and
/// name, and the others to switch to. Only with more than one profile.
struct ProfileMenu: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if AppProfile.hasSeveral, let current = AppProfile.current {
            IconMenu {
                ForEach(Array(AppProfile.all.enumerated()), id: \.element.id) { index, entry in
                    Button {
                        AppProfile.switchTo(entry, app: app)
                    } label: {
                        Label(entry.name, systemImage: entry == current ? "checkmark.circle.fill" : "circle.fill")
                    }
                    .disabled(entry == current || !AppProfile.canSwitch)
                    .keyboardShortcut(KeyEquivalent(Character(String(min(index + 1, 9)))), modifiers: [.control, .command])
                }
                Divider()
                Button("Manage Profiles…", systemImage: "person.2") { app.openSettings(tab: .profiles) }
            } label: {
                HStack(spacing: zoomed(5)) {
                    Circle().fill(AppProfile.colour(current) ?? Color.secondary).frame(width: zoomed(8), height: zoomed(8))
                    Text(current.name).font(.system(size: TypeScale.label, weight: .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: zoomed(8), weight: .semibold)).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
            .tip("You're in the \(current.name) profile: its own threads, logins and Convex. Pick another to switch (⌃⌘1, ⌃⌘2…)")
        }
    }
}

/// A thin bar of the profile's colour along the top of the window, so it's
/// clear which profile you're in. Only with more than one profile.
struct ProfileStrip: View {
    var body: some View {
        if AppProfile.hasSeveral, let current = AppProfile.current, let colour = AppProfile.colour(current) {
            Rectangle().fill(colour).frame(height: 3).allowsHitTesting(false)
                .accessibilityLabel("\(current.name) profile")
        }
    }
}
