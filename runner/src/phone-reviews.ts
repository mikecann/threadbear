// The phone gets the review's words and stills, never local file paths or
// executable pages. Sources match the private reply-image mirror.
import crypto from 'node:crypto';
import type { DesignReview } from './protocol.ts';

export function reviewImageSource(reviewId: string, imagePath: string): string {
  return `review:${reviewId}:${crypto.createHash('sha256').update(imagePath).digest('hex')}`;
}

export function phoneReview(review: DesignReview) {
  return {
    id: review.id, title: review.title, status: review.status, revision: review.revision,
    ...(review.note ? { note: review.note } : {}),
    ...(review.recommended ? { recommended: review.recommended } : {}),
    draft: review.response ?? review.draft,
    options: review.options.map(option => ({
      id: option.id, title: option.title,
      ...(option.note ? { note: option.note } : {}),
      ...(option.reference ? { reference: true } : {}),
      shots: (option.shots ?? [{ image: option.image }]).map(shot => ({
        src: reviewImageSource(review.id, shot.image.path),
        ...(shot.title ? { title: shot.title } : {}),
        kind: shot.media?.mediaType === 'text/html' ? 'page' : shot.media ? 'video' : 'image',
      })),
    })),
  };
}
