import AppKit
import ThreadbearCore

/// The public profile page's side of AppModel (docs/protocol.md, "Profile
/// page"): the Customize panel's Profile page section reads and saves it
/// through the runner, which sends it to the Convex backend.
extension AppModel {
    /// When the Customize panel opens. A runner from before the profile
    /// page says so, and the section says to update.
    func loadProfilePage() {
        guard let client else { return }
        Task {
            do {
                profilePage = try await client.profilePage()
                profilePageMissing = false
            } catch RPCError.server(let code, _) where code == RPCError.methodNotFound {
                profilePageMissing = true
            } catch {
                AppLog.write("rpc", "profilePage.get failed: \(error.localizedDescription)")
            }
        }
    }

    /// Saves and sends it, with the Librarian page's layout and pictures
    /// filled in. The section saves as you change it, as the rest of
    /// Customize does, and says Saving… while this runs; a change made
    /// meanwhile waits and goes straight after, so the last one always
    /// lands. A refusal shows in the banner and leaves the panel as it is.
    func saveProfilePage(_ settings: ProfilePageSettings, look: LibrarianLook) {
        guard let client else { return }
        var s = settings.sendable
        s.order = ProfilePageSettings.cardOrder(look)
        s.picturePath = Self.profilePicturePath(look)
        if !ProfilePageSettings.heldBack.contains(.background) {
            s.backgroundPath = look.background.map { Looks.folder.appendingPathComponent($0).path }
            s.backgroundDim = look.background == nil ? nil : look.backgroundDim
        }
        let github = GitHubUser.clean(look.githubUser)
        s.githubUser = github.isEmpty ? nil : github
        if isBusy(BusyKey.saveProfilePage) {
            profilePageNext = s
            return
        }
        whileBusy(BusyKey.saveProfilePage) { [self] in
            var next: ProfilePageSettings? = s
            while let send = next {
                profilePageNext = nil
                do {
                    profilePage = try await client.updateProfilePage(send)
                } catch {
                    show(error)
                }
                next = profilePageNext
            }
        }
    }

    func removeProfilePage() {
        guard let client else { return }
        whileBusy(BusyKey.saveProfilePage, note: "Taking your profile page down") { [self] in
            do {
                profilePage = try await client.removeProfilePage()
            } catch {
                show(error)
            }
        }
    }

    /// The Librarian page's picture as a file the runner can read: your own
    /// from the looks folder, or a scaled copy of the bear made once.
    private static func profilePicturePath(_ look: LibrarianLook) -> String? {
        switch look.picture {
        case .none: return nil
        case .own: return look.pictureFile.map { Looks.folder.appendingPathComponent($0).path }
        case .bear:
            let key = "profilePageBear"
            if let name = UserDefaults.standard.string(forKey: key),
               FileManager.default.fileExists(atPath: Looks.folder.appendingPathComponent(name).path) {
                return Looks.folder.appendingPathComponent(name).path
            }
            guard let url = Art.librarianURL, let name = Looks.importPicture(from: url, maxSide: 480, prefix: "profile-bear") else { return nil }
            UserDefaults.standard.set(name, forKey: key)
            return Looks.folder.appendingPathComponent(name).path
        }
    }
}
