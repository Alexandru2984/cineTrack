import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AboutPage from '@/pages/About';

describe('About page', () => {
  it('keeps TMDB attribution in the required credits-style section', () => {
    render(<AboutPage />);

    expect(screen.getByRole('heading', { name: 'About Văzute' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Data sources' })).toBeVisible();
    expect(screen.getByAltText('TMDB')).toBeVisible();
    expect(screen.getByText(
      'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    )).toBeVisible();
    expect(screen.getByRole('link', { name: 'The Movie Database' })).toHaveAttribute(
      'href',
      'https://www.themoviedb.org',
    );
    expect(screen.getByText(
      'Streaming availability data, when displayed, is provided by JustWatch.',
    )).toBeVisible();
    expect(screen.getByRole('link', { name: 'JustWatch' })).toHaveAttribute(
      'href',
      'https://www.justwatch.com/ro',
    );
  });
});
