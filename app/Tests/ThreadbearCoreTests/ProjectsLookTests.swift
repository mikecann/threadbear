import Foundation
import XCTest
@testable import ThreadbearCore

final class ProjectsLookTests: XCTestCase {
    func testStandardLookIsThePageAsItShips() {
        let look = ProjectsLook.standard
        XCTAssertEqual(look.picture, .none, "the page has no picture as it ships")
        XCTAssertEqual(look.layout, [.header, .cards])
        XCTAssertTrue(ProjectsLook.CardPart.allCases.allSatisfy(look.shows), "every card part shows")
        XCTAssertTrue(look.isStandard)
    }

    func testPartsMoveToTopMiddleOrBottom() {
        var look = ProjectsLook()
        XCTAssertEqual(ProjectsLook.Block.allCases.map(look.place), [.top, .top, .top])
        look.setPlace(.bottom, for: .header)
        XCTAssertEqual(look.layout, [.cards, .header])
        look.setPlace(.middle, for: .cards)
        XCTAssertEqual(look.layout, [.cards, .header])
        look.setPlace(.top, for: .header)
        look.setPlace(.top, for: .cards)
        XCTAssertTrue(look.isStandard, "moving back isn't kept as a change")
    }

    func testPictureIsOnlyEverYourOwn() {
        var look = ProjectsLook()
        look.picture = .own
        XCTAssertFalse(look.shows(.picture), "your picture needs a file")
        look.pictureFile = "picture.png"
        XCTAssertEqual(look.layout, [.picture, .header, .cards])
        look.setShown(false, for: .picture)
        look.showPicture()
        XCTAssertTrue(look.shows(.picture), "choosing a picture puts it back on the page")
        look.picture = .bear
        XCTAssertFalse(look.shows(.picture), "there's no bear on this page")
    }

    func testCardPartsHide() {
        var look = ProjectsLook()
        look.setShown(false, for: ProjectsLook.CardPart.art)
        look.setShown(false, for: ProjectsLook.CardPart.state)
        XCTAssertEqual(look.hiddenCardParts, [.art, .state])
        XCTAssertFalse(look.isStandard)
        look.setShown(true, for: ProjectsLook.CardPart.art)
        look.setShown(true, for: ProjectsLook.CardPart.state)
        XCTAssertTrue(look.isStandard)
    }

    func testRoundTripsAndToleratesOtherBuilds() {
        var look = ProjectsLook()
        look.picture = .own
        look.pictureFile = "a.png"
        look.pictureSize = .large
        look.background = "b.jpg"
        look.backgroundDim = 0.2
        look.backgroundFocus = BackdropFocus(x: 0.1, y: 0.3)
        look.setPlace(.bottom, for: .cards)
        look.hidden = [.header]
        look.hiddenCardParts = [.status]
        XCTAssertEqual(ProjectsLook.load(look.data()), look)

        let odd = #"{"picture":"bear","places":{"cards":"middle","rocket":"top","header":"sideways"},"hidden":["picture","numbers"],"hiddenCardParts":["art","sparkles"],"backgroundDim":9,"newThing":1}"#
        let loaded = ProjectsLook.load(Data(odd.utf8))
        XCTAssertEqual(loaded.picture, .none, "a bear from another build is none here")
        XCTAssertEqual(loaded.place(.cards), .middle)
        XCTAssertEqual(loaded.place(.header), .top)
        XCTAssertEqual(loaded.hidden, [.picture])
        XCTAssertEqual(loaded.hiddenCardParts, [.art])
        XCTAssertEqual(loaded.backgroundDim, 1)
        XCTAssertEqual(ProjectsLook.load(Data("nonsense".utf8)), .standard)
        XCTAssertEqual(ProjectsLook.load(nil), .standard)
    }
}
