import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityRating } from '@/components/CommunityRating';
import type { CommunityRating as CommunityRatingData } from '@/types';

const mocks = vi.hoisted(() => ({
  result: {} as { data?: CommunityRatingData; isLoading: boolean },
}));

vi.mock('@/hooks/useMedia', () => ({
  useCommunityRating: () => mocks.result,
}));

describe('CommunityRating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when no member has rated the title', () => {
    mocks.result = { isLoading: false, data: { count: 0, average: null, distribution: null } };
    const { container } = render(<CommunityRating mediaId="603" mediaType="movie" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while loading with no cached data', () => {
    mocks.result = { isLoading: true };
    const { container } = render(<CommunityRating mediaId="603" mediaType="movie" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the average and distribution above the display floor', () => {
    mocks.result = {
      isLoading: false,
      data: {
        count: 4,
        average: 8.5,
        // index 0 = one star … index 9 = ten stars
        distribution: [0, 0, 0, 0, 0, 1, 0, 1, 0, 2],
      },
    };
    render(<CommunityRating mediaId="603" mediaType="movie" />);

    expect(screen.getByRole('heading', { name: /Văzute community/ })).toBeInTheDocument();
    expect(screen.getByText('8.5')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Average 8.5 out of 10 from 4 ratings.' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Individual ratings stay private/)).toBeInTheDocument();
  });

  it('withholds the average below the floor but still shows the count', () => {
    mocks.result = {
      isLoading: false,
      data: { count: 2, average: null, distribution: null },
    };
    render(<CommunityRating mediaId="603" mediaType="movie" />);

    expect(screen.getByText(/Rated by 2 members/)).toBeInTheDocument();
    // No average badge and no distribution image.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
