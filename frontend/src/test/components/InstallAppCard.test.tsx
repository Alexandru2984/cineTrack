import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallAppCard } from '@/components/InstallAppCard';

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  value: {
    canInstall: false,
    isStandalone: false,
    needsManualInstall: false,
  },
}));

vi.mock('@/hooks/usePwaInstall', () => ({
  usePwaInstall: () => ({
    ...mocks.value,
    install: mocks.install,
  }),
}));

describe('InstallAppCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.value.canInstall = false;
    mocks.value.isStandalone = false;
    mocks.value.needsManualInstall = false;
  });

  it('launches the browser install prompt when available', async () => {
    const user = userEvent.setup();
    mocks.value.canInstall = true;
    render(<InstallAppCard />);

    await user.click(screen.getByRole('button', { name: 'Install app' }));
    expect(mocks.install).toHaveBeenCalledOnce();
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
    mocks.value.canInstall = true;
    mocks.value.isStandalone = true;
    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
  });
});
