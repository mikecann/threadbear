import Foundation
import Testing
@testable import ThreadbearCore

/// The public profile page's settings (ProfilePage.swift): handle and link
/// rules, the web page's card order from the Librarian page's layout, and
/// decoding what another build saved.
struct ProfilePageTests {
    @Test func handles() {
        #expect(ProfilePageSettings.handleProblem("wayne") == nil)
        #expect(ProfilePageSettings.handleProblem("wayne-sutton-2") == nil)
        for bad in ["ab", "-wayne", "wayne-", "way--ne", "Wayne", "way ne", String(repeating: "w", count: 31)] {
            #expect(ProfilePageSettings.handleProblem(bad) != nil, "\(bad)")
        }
        #expect(ProfilePageSettings.cleanHandle(" @Wayne Sutton ") == "wayne-sutton")
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

    @Test func decodesWhatOtherBuildsSaved() throws {
        let json = #"{"published":true,"handle":"wayne","show":["activity","fromTheFuture"],"links":[{"title":"X","url":"https://x.com/waynesutton"}],"extra":1}"#
        let s = try JSONDecoder().decode(ProfilePageSettings.self, from: Data(json.utf8))
        #expect(s.published && s.handle == "wayne")
        #expect(s.show == [.activity])
        #expect(s.links.count == 1 && s.name.isEmpty)
        let back = try JSONDecoder().decode(ProfilePageSettings.self, from: JSONEncoder().encode(s))
        #expect(back == s)
        let status = try JSONDecoder().decode(ProfilePageStatus.self, from: Data(#"{"profile":null,"url":"https://a.convex.site/@wayne"}"#.utf8))
        #expect(status.profile == nil && status.url == "https://a.convex.site/@wayne")
    }
}
