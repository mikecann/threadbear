# Mobile review files

- `runner/src/phone-reviews.ts`: review data for the phone without local paths.
- `runner/src/share-images.ts`: still previews through existing private image sync.
- `runner/src/sync.ts` and `handover.ts`: review commands and forwarding during runner handover.
- `convex/phone.ts`, `schema.ts`, `sync.ts`, `version.ts`: authenticated API 83 commands and indexed preview lookup.
- `ios/Threadbear/DesignReviewsView.swift` and `ThreadView.swift`: review sheet and entry points.
- `ios/ThreadbearKit/Sources/ThreadbearKit/DesignReviews.swift`: typed review data and answer validation.
- `Backend.swift`, `Models.swift`, `ThreadLinks.swift`, `FakeBackend.swift`: transport, links and synthetic simulator fixture.
- `runner/test/helpers/phone-review-scenario.ts`: runner/backend integration scenario.
- `phone-reviews.test.ts`, `scenarios.test.ts`, `DesignReviewsTests.swift`, `ThreadLinksTests.swift`: mapping, integration and phone regressions.
