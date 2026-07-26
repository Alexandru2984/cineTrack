import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageCard } from '@/components/LanguageCard';
import { useLocaleStore } from '@/store/locale';

describe('LanguageCard', () => {
  beforeEach(() => {
    useLocaleStore.getState().setLocale('en');
  });

  it('renders the switcher in the active language and toggles it', async () => {
    const user = userEvent.setup();
    render(<LanguageCard />);

    // English is active: the heading is the English label.
    expect(screen.getByRole('heading', { name: 'Language' })).toBeVisible();
    const romanian = screen.getByRole('button', { name: 'Română' });
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(romanian);

    // Switching updates the store and re-renders the heading in Romanian.
    expect(useLocaleStore.getState().locale).toBe('ro');
    expect(screen.getByRole('heading', { name: 'Limbă' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Română' })).toHaveAttribute('aria-pressed', 'true');
  });
});
