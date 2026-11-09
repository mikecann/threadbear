import Foundation
import Testing
@testable import ThreadbearCore

/// The public profile page's settings (ProfilePage.swift): link rules, what
/// goes to the runner, the web page's card order from the Librarian page's
/// layout, and decoding what another build saved.
struct ProfilePageTests {
    @Test func whatIsSent() {
        var s = ProfilePageSettings()
        s.links = [.init(title: "GitHub", url: "https://github.com/waynesutton"), .init(title: "Half typed", url: "https://")]
        s.home = true
        let sent = s.sendable
        #expect(sent.links.map(\.title) == ["GitHub"], "a link still being typed waits")
        #expect(!sent.home, "the front page needs it published")
        s.published = true
        #expect(s.sendable.home)
    }

    @Test func links() {
        #expect(ProfilePageSettings.linkProblem("https://github.com/waynesutton") == nil)
        #expect(ProfilePageSettings.linkProblem("javascript:alert(1)") != nil)
        #expect(ProfilePageSettings.linkProblem("github.com") != nil)
    }

    @Test func cardsFollowTheLibrarianPage() {
        var look = LibrarianLook()
        #expect(ProfilePageSettings.cardOrder(look) == ["numbers", "activity", "github", "projects"])
        look.setPlace(.top, for: .github)
        #expect(ProfilePageSettings.cardOrder(look) == ["github", "numbers", "activity", "projects"])
        look.setPlace(.bottom, for: .numbers)
        #expect(ProfilePageSettings.cardOrder(look) == ["github", "numbers", "activity", "projects"])
        look.setPlace(.bottom, for: .github)
        look.setPlace(.top, for: .numbers)
        #expect(ProfilePageSettings.cardOrder(look) == ["numbers", "activity", "github", "projects"])
    }

    @Test func partsStartOffAndToggle() {
        var s = ProfilePageSettings()
        #expect(s.show.isEmpty && !s.published)
        s.setShown(true, .activity)
        s.setShown(true, .activity)
        #expect(s.show == [.activity])
        s.setShown(false, .activity)
        #expect(s.show.isEmpty)
    }

    @Test func changelogRepository() throws {
        var s = ProfilePageSettings()
        #expect(s.changelogRepo(for: "waynesutton") == "waynesutton/threadbear", "nothing typed: the fork's usual name")
        #expect(s.changelogRepo(for: "") == nil, "no GitHub user, no changelog")
        s.changelogRepo = "https://github.com/mikecann/threadbear.git"
        #expect(s.changelogRepo(for: "waynesutton") == "mikecann/threadbear")
        s.changelogRepo = "half typed"
        #expect(s.changelogRepo(for: "waynesutton") == nil)
        #expect(ProfilePageSettings.cleanRepo("waynesutton/..") == "")
        #expect(s.sendable.changelogRepo == "half typed", "sent as typed; the runner reads it")
        s.setShown(true, .changelog)
        let back = try JSONDecoder().decode(ProfilePageSettings.self, from: JSONEncoder().encode(s))
        #expect(back.shows(.changelog) && back.changelogRepo == "half typed")
        #expect(ProfilePageSettings.offered.contains(.changelog))
    }

    @Test func decodesWhatOtherBuildsSaved() throws {
        // As saved before 9 Nov, with a handle and no home.
        let json = #"{"published":true,"handle":"wayne","show":["activity","fromTheFuture"],"links":[{"title":"X","url":"https://x.com/waynesutton"}],"extra":1}"#
        let s = try JSONDecoder().decode(ProfilePageSettings.self, from: Data(json.utf8))
        #expect(s.published && !s.home)
        #expect(!String(decoding: try JSONEncoder().encode(s), as: UTF8.self).contains("handle"))
        #expect(s.show == [.activity])
        #expect(s.links.count == 1 && s.name.isEmpty)
        let back = try JSONDecoder().decode(ProfilePageSettings.self, from: JSONEncoder().encode(s))
        #expect(back == s)
        let status = try JSONDecoder().decode(ProfilePageStatus.self, from: Data(#"{"profile":null,"url":"https://a.convex.site/profile"}"#.utf8))
        #expect(status.profile == nil && status.url == "https://a.convex.site/profile")
    }

    @Test func backgroundPhotoIsHeldBack() {
        #expect(!ProfilePageSettings.offered.contains(.background))
        var settings = ProfilePageSettings()
        settings.show = [.picture, .background]
        settings.backgroundPath = "/tmp/b.jpg"
        settings.backgroundDim = 0.4
        let sent = settings.sendable
        #expect(sent.show == [.picture], "an older build's switch doesn't send it")
        #expect(sent.backgroundPath == nil)
        #expect(sent.backgroundDim == nil)
    }
}
