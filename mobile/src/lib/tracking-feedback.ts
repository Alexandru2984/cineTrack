export const MAX_REVIEW_LENGTH = 5000;

export interface TrackingFeedbackPayload {
  rating: number | null;
  review: string | null;
}

export function buildTrackingFeedbackPayload(
  rating: number | null,
  review: string,
): TrackingFeedbackPayload {
  const normalizedReview = review.trim();
  return {
    rating,
    review: normalizedReview || null,
  };
}
