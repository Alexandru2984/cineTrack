import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaProvider, PwaStatus } from '@/components/PwaLifecycle';
import { isIosInstallPlatform } from '@/lib/pwa';

/** Captures what PwaProvider passes to useRegisterSW, so the registration
 *  callbacks can be driven directly. */
interface CapturedRegisterOptions {
  onRegisteredSW?: (url: string, registration?: unknown) => void;
}

interface RegisterState {
  options: CapturedRegisterOptions | null;
  setNeedRefresh: ReturnType<typeof vi.fn>;
  needRefresh: boolean;
}

const registerState: RegisterState = {
  options: null,
  setNeedRefresh: vi.fn(),
  needRefresh: false,
};

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: Record<string, unknown>) => {
    registerState.options = options as CapturedRegisterOptions;
    return {
      offlineReady: [false, vi.fn()],
      needRefresh: [registerState.needRefresh, registerState.setNeedRefresh],
      updateServiceWorker: vi.fn(),
    };
  },
}));

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

describe('native PWA installation', () => {
  it('tracks browser connectivity events', () => {
    render(
      <PwaProvider>
        <div>Application shell</div>
      </PwaProvider>,
    );

    fireEvent(window, new Event('offline'));
    expect(screen.getByRole('status')).toHaveTextContent('You are offline');

    fireEvent(window, new Event('online'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not suppress the browser install promotion', () => {
    render(
      <PwaProvider>
        <div>Application shell</div>
      </PwaProvider>,
    );

    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
});

describe('PwaProvider update discovery', () => {
  // Reset here rather than inside the helper: assigning null in the same
  // function body narrows the field for every later read, and the mock
  // repopulates it from a scope the checker cannot follow.
  beforeEach(() => {
    registerState.options = null;
    registerState.setNeedRefresh = vi.fn();
  });

  function mountWithRegistration() {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<PwaProvider><div /></PwaProvider>);
    expect(registerState.options).not.toBeNull();
    registerState.options?.onRegisteredSW?.('/sw.js', { update });
    return update;
  }

  it('asks for a new build on a timer, so an open tab does not run a stale one', () => {
    // A worker only looks for a new version when the browser asks it to, which
    // in practice means a full navigation. Without this, a deployed fix never
    // reaches a tab that stays open — the failure that sent a user looking for
    // a button that had already shipped.
    vi.useFakeTimers();
    const update = mountWithRegistration();
    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(update).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('asks again when the tab returns to the foreground', () => {
    // Phones restore an app from the background without reloading it, so
    // foregrounding is the moment a user is most likely to be waiting on a fix.
    const update = mountWithRegistration();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not ask while offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const update = mountWithRegistration();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).not.toHaveBeenCalled();
    onLine.mockRestore();
  });

  it('treats dismissing the banner as a snooze, not a silence', () => {
    // Dismissing used to suppress the prompt for the rest of the session, so a
    // stray tap meant staying on a superseded build indefinitely.
    vi.useFakeTimers();
    registerState.needRefresh = true;
    registerState.setNeedRefresh = vi.fn();
    render(<PwaProvider><div /></PwaProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(registerState.setNeedRefresh).toHaveBeenCalledWith(false);

    registerState.setNeedRefresh.mockClear();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(registerState.setNeedRefresh).toHaveBeenCalledWith(true);

    registerState.needRefresh = false;
    vi.useRealTimers();
  });
});
