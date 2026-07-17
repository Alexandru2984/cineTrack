import {
  buildTrackingFeedbackPayload,
  MAX_REVIEW_LENGTH,
} from '@/lib/tracking-feedback';

describe('tracking feedback payloads', () => {
  it('turns cleared feedback into explicit null values', () => {
    expect(buildTrackingFeedbackPayload(null, '   ')).toEqual({
      rating: null,
      review: null,
    });
  });

  it('trims review boundaries without changing its contents', () => {
    expect(buildTrackingFeedbackPayload(9, '  Great\nfilm.  ')).toEqual({
      rating: 9,
      review: 'Great\nfilm.',
    });
  });

  it('keeps the client limit aligned with the API contract', () => {
    expect(MAX_REVIEW_LENGTH).toBe(5000);
  });
});
