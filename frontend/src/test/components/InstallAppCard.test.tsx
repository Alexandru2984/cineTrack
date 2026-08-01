import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAppCard } from '@/components/InstallAppCard';

const mocks = vi.hoisted(() => ({
  value: {
    isStandalone: false,
    needsManualInstall: false,
  },
}));

vi.mock('@/hooks/usePwaInstall', () => ({
  usePwaInstall: () => mocks.value,
}));

describe('InstallAppCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.value.isStandalone = false;
    mocks.value.needsManualInstall = false;
  });

  it('shows the Safari installation path on iPhone and iPad', () => {
    mocks.value.needsManualInstall = true;
    render(<InstallAppCard />);

    expect(screen.getByRole('heading', { name: 'Install Văzute' })).toBeVisible();
    expect(screen.getByText('Open this page in Safari, then:')).toBeVisible();
    expect(screen.getByText('Share')).toBeVisible();
    expect(screen.getByText('Add to Home Screen')).toBeVisible();
  });

  it('stays hidden after installation', () => {
    mocks.value.needsManualInstall = true;
    mocks.value.isStandalone = true;
    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
  });
});
