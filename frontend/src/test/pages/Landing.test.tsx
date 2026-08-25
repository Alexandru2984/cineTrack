import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import LandingPage from '@/pages/Landing';

/** What this is for.
 *
 *  `/` sent anyone without a session straight to the sign-in form, which
 *  greeted a first-time visitor with "welcome back" and two empty fields.
 *  Everybody arriving from a shared link or a search result met a login wall
 *  that never said what they had arrived at — and `/` is the address every
 *  canonical on the site points at, so the one page search engines were told to
 *  index had no content either.
 */
function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe('Landing', () => {
  it('says what the thing is before asking for anything', () => {
    renderLanding();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/keep track of what you watch/i);
    expect(screen.getByText(/no adverts, no feed/i)).toBeInTheDocument();
  });

  it('offers both doors, not only the one for people who already belong', () => {
    renderLanding();

    expect(screen.getByRole('link', { name: /create a free account/i })).toHaveAttribute(
      'href',
      '/register',
    );
    // Someone who does have an account should not be pushed through sign-up.
    expect(screen.getByRole('link', { name: /already have an account/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('does not greet a stranger as though they had been here before', () => {
    renderLanding();

    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it('reaches the pages somebody deciding whether to sign up would want', () => {
    renderLanding();

    expect(screen.getByRole('link', { name: /about/i })).toHaveAttribute('href', '/about');
    expect(screen.getByRole('link', { name: /privacy/i })).toHaveAttribute('href', '/privacy');
  });

  it('describes what the app actually does, in four claims it can keep', () => {
    renderLanding();

    // Each of these is a real behaviour of the product, not a slogan: the
    // timezone-correct calendar, per-episode tracking, statistics recomputed
    // from history, and private-by-default profiles.
    expect(screen.getByText(/in your own timezone/i)).toBeInTheDocument();
    expect(screen.getByText(/episode by episode/i)).toBeInTheDocument();
    expect(screen.getByText(/recomputed if you change it/i)).toBeInTheDocument();
    expect(screen.getByText(/without being able to read them/i)).toBeInTheDocument();
  });
});
