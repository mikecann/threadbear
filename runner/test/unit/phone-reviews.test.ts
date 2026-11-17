import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneReview } from '../../src/phone-reviews.ts';
import { replyImagesInEvent } from '../../src/share-images.ts';
import type { DesignReview, PersistedEvent } from '../../src/protocol.ts';

const review: DesignReview = {
  id: 'review-id', title: 'Pick a layout', recommended: 'A', status: 'pending', revision: 0,
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', draft: { notes: {} },
  options: [{ id: 'A', title: 'First', image: { path: '/private/first.png', mediaType: 'image/png' },
    shots: [{ title: 'Overview', image: { path: '/private/first.png', mediaType: 'image/png' }, media: { path: '/private/page.html', mediaType: 'text/html' } }] },
  { id: 'B', title: 'Today', reference: true, image: { path: '/private/ref.png', mediaType: 'image/png' } }],
};

test('phone reviews keep choices and labels without exposing local paths or HTML', () => {
  const dto = phoneReview(review);
  assert.equal(dto.recommended, 'A');
  assert.equal(dto.options[1].reference, true);
  assert.equal(dto.options[0].shots[0].kind, 'page');
  assert.equal(dto.options[0].shots[0].title, 'Overview');
  assert.ok(!JSON.stringify(dto).includes('/private/'));
  assert.deepEqual(dto.draft, { notes: {} });
});

test('review stills use the same opaque sources as the phone, once per creation', () => {
  const event = { type: 'review.updated', review, seq: 4, ts: review.createdAt, threadId: 't' } as PersistedEvent;
  const images = replyImagesInEvent(event, '/work');
  assert.equal(images.length, 2);
  assert.equal(images[0].src, phoneReview(review).options[0].shots[0].src);
  assert.equal(images[0].path, '/private/first.png');
  assert.deepEqual(replyImagesInEvent({ ...event, review: { ...review, revision: 1 } } as PersistedEvent, '/work'), []);
});
