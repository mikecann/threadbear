import SwiftUI
import ThreadbearCore

/// Where Settings opens (Settings > General): over the main panel, the
/// default, or in a window of its own as Mac apps' do.
enum SettingsPlace: String, CaseIterable, Identifiable {
    case panel, window

    static let key = "settingsPlace"
    var id: String { rawValue }

    var title: String {
        switch self {
        case .panel: "Main window"
        case .window: "Its own window"
        }
    }

    static var current: SettingsPlace {
        UserDefaults.standard.string(forKey: key).flatMap(SettingsPlace.init(rawValue:)) ?? .panel
    }
}

extension AppModel {
    /// ⌘,, the gear and every "open Settings ›" button: the page over the
    /// main panel, or the window, as Settings > General says. The scripted
    /// app's `settings` command still uses the window (settingsRequest).
    func openSettings(tab: SettingsTab? = nil) {
        if let tab { settingsTab = tab }
        // A Settings window that's open already is brought forward instead.
        if SettingsPlace.current == .panel, SettingsWindow.current?.isVisible != true {
            showsSkillsPage = false
            showsNotesPage = false
            showsSettingsPage = true
        } else {
            settingsRequest += 1
        }
    }
}

/// Settings over the main panel: the same tabs as the window, with an X
/// (and Esc) that closes it. It covers whatever was open without closing
/// it, so closing Settings puts you back in the same thread, project or page.
struct SettingsPage: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Settings")
                    .font(.system(size: zoomed(17), weight: .semibold))
                Spacer()
                Button {
                    app.showsSettingsPage = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: zoomed(12), weight: .semibold))
                        .frame(width: zoomed(28), height: zoomed(28))
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .tip("Close Settings (Esc)")
                .accessibilityLabel("Close Settings")
            }
            // Well in from the edge: the divider beside the panel has a
            // grab area for resizing that would take a click meant for the X.
            .padding(.leading, zoomed(20))
            .padding(.trailing, zoomed(28))
            .padding(.vertical, zoomed(12))
            Divider()
            ScrollView {
                SettingsView(inPanel: true)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, zoomed(16))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        // Esc closes it, unless something inside (a menu, a field) takes it first.
        .onExitCommand { app.showsSettingsPage = false }
    }
}
