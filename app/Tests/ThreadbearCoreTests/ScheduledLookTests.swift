import Foundation
import XCTest
@testable import ThreadbearCore

final class ScheduledLookTests: XCTestCase {
    func testStandardLookIsThePageAsItShips() {
        let look = ScheduledLook.standard
        XCTAssertEqual(look.layout, [.picture, .about, .numbers])
        XCTAssertTrue(look.isStandard)
    }

    func testPartsMoveToTopMiddleOrBottom() {
        var look = ScheduledLook()
        look.setPlace(.bottom, for: .picture)
        look.setPlace(.top, for: .numbers)
        XCTAssertEqual(look.layout, [.about, .numbers, .picture])
        look.setPlace(.middle, for: .about)
        XCTAssertEqual(look.layout, [.numbers, .about, .picture])
        // Moving back to where each starts isn't kept as a change.
        look.setPlace(.top, for: .picture)
        look.setPlace(.middle, for: .numbers)
        look.setPlace(.top, for: .about)
        XCTAssertTrue(look.isStandard)
    }

    func testHidingAndPictureChoices() {
        var look = ScheduledLook()
        look.setShown(false, for: .about)
        XCTAssertEqual(look.layout, [.picture, .numbers])
        look.picture = .none
        XCTAssertEqual(look.layout, [.numbers])
        look.picture = .own
        XCTAssertFalse(look.shows(.picture), "your picture needs a file")
        look.pictureFile = "picture.png"
        look.setShown(false, for: .picture)
        look.showPicture()
        XCTAssertTrue(look.shows(.picture), "choosing a picture puts it back on the page")
    }

    func testRoundTripsAndToleratesOtherBuilds() {
        var look = ScheduledLook()
        look.picture = .own
        look.pictureFile = "a.png"
        look.pictureSize = .small
        look.background = "b.jpg"
        look.backgroundDim = 0.2
        look.backgroundFocus = BackdropFocus(x: 0.1, y: 0.3)
        look.setPlace(.bottom, for: .about)
        look.hidden = [.numbers]
        look.hiddenNumbers = ["paused"]
        XCTAssertEqual(ScheduledLook.load(look.data()), look)

        let odd = #"{"picture":"hologram","places":{"numbers":"top","rocket":"top","about":"sideways"},"hidden":["picture","greeting"],"backgroundDim":-4,"newThing":1}"#
        let loaded = ScheduledLook.load(Data(odd.utf8))
        XCTAssertEqual(loaded.picture, .bear)
        XCTAssertEqual(loaded.place(.numbers), .top)
        XCTAssertEqual(loaded.place(.about), .top)
        XCTAssertEqual(loaded.hidden, [.picture])
        XCTAssertEqual(loaded.backgroundDim, 0)
        XCTAssertEqual(ScheduledLook.load(Data("nonsense".utf8)), .standard)
        XCTAssertEqual(ScheduledLook.load(nil), .standard)
    }
}
