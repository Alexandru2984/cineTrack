import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PwaStatus } from '@/components/PwaLifecycle';
import { isIosInstallPlatform } from '@/lib/pwa';

function statusProps() {
  return {
    isOnline: true,
    needRefresh: false,
    offlineReady: false,
    onUpdate: vi.fn(),
    onDismissUpdate: vi.fn(),
    onDismissReady: vi.fn(),
  };
}

describe('PwaStatus', () => {
  it('offers an explicit update without forcing a reload', () => {
    const props = statusProps();
    render(<PwaStatus {...props} needRefresh />);

    expect(screen.getByRole('alert')).toHaveTextContent('A new version is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(props.onUpdate).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.onDismissUpdate).toHaveBeenCalledOnce();
  });

  it('prioritizes persistent offline state over transient notices', () => {
    const props = statusProps();
    render(
      <PwaStatus
        {...props}
        isOnline={false}
        needRefresh
        offlineReady
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('You are offline');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('allows the offline-ready notice to be dismissed', () => {
    const props = statusProps();
    render(<PwaStatus {...props} offlineReady />);

    expect(screen.getByRole('status')).toHaveTextContent('Ready for offline launch');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.onDismissReady).toHaveBeenCalledOnce();
  });
});

describe('iOS PWA installation detection', () => {
  it('recognizes iPhone and touch-capable iPad desktop mode', () => {
    expect(isIosInstallPlatform('Mozilla/5.0 (iPhone)', 'iPhone', 5)).toBe(true);
    expect(isIosInstallPlatform('Mozilla/5.0 (Macintosh)', 'MacIntel', 5)).toBe(true);
  });

  it('does not show iOS instructions on desktop browsers', () => {
    expect(isIosInstallPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64', 0))
      .toBe(false);
    expect(isIosInstallPlatform('Mozilla/5.0 (Macintosh)', 'MacIntel', 0)).toBe(false);
  });
});
