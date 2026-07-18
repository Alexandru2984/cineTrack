import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchProviders } from '@/components/WatchProviders';
import type { WatchProviders as WatchProvidersData } from '@/types';

const mocks = vi.hoisted(() => ({ result: {} as { data?: WatchProvidersData; isLoading: boolean } }));

vi.mock('@/hooks/useMedia', () => ({
  useWatchProviders: () => mocks.result,
}));

describe('WatchProviders', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders grouped providers with required JustWatch attribution', () => {
    mocks.result = {
      isLoading: false,
      data: {
        region: 'RO',
        link: 'https://www.justwatch.com/ro/film/example',
        stream: [{ provider_id: 8, name: 'Netflix', logo_path: '/nf.jpg' }],
        rent: [{ provider_id: 3, name: 'Apple TV', logo_path: '/apple.jpg' }],
        buy: [],
      },
    };
    render(<WatchProviders tmdbId={603} mediaType="movie" />);

    expect(screen.getByRole('heading', { name: 'Where to watch' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Netflix' })).toBeInTheDocument();
    expect(screen.getByText('Rent')).toBeInTheDocument();
    const attribution = screen.getByRole('link', { name: 'JustWatch' });
    expect(attribution).toHaveAttribute('href', 'https://www.justwatch.com/ro/film/example');
  });

  it('shows an empty-region message but keeps the attribution', () => {
    mocks.result = {
      isLoading: false,
      data: { region: 'JP', link: null, stream: [], rent: [], buy: [] },
    };
    render(<WatchProviders tmdbId={603} mediaType="movie" />);

    expect(screen.getByText(/No streaming, rental, or purchase options/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'JustWatch' })).toBeInTheDocument();
  });

  it('renders nothing while the first request is loading', () => {
    mocks.result = { isLoading: true, data: undefined };
    const { container } = render(<WatchProviders tmdbId={603} mediaType="movie" />);
    expect(container).toBeEmptyDOMElement();
  });
});
