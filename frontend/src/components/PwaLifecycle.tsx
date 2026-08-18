import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { CheckCircle2, CloudOff, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { PwaContext, type PwaContextValue } from '@/hooks/usePwaInstall';
import { useAuthStore } from '@/store/auth';
import { isIosInstallPlatform } from '@/lib/pwa';
import { useT } from '@/hooks/useT';

/** How often an open tab asks whether a newer build exists.
 *
 *  Short enough that a fix reaches an already-open client the same session,
 *  long enough to be irrelevant next to the traffic the app already makes. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** How long dismissing the update banner puts it away for.
 *
 *  Dismissing used to silence it for the rest of the session, so one stray tap
 *  meant running a superseded build indefinitely — including past a fix the
 *  user was actively waiting for. Snoozing keeps the escape hatch without
 *  making it permanent. */
const UPDATE_SNOOZE_MS = 10 * 60 * 1000;

function standaloneMode(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches
    || iosNavigator.standalone === true;
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const [isStandalone, setIsStandalone] = useState(standaloneMode);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    // A registered worker only looks for a new version when the browser
    // happens to ask it to — in practice, on a full navigation. A tab left
    // open, or a phone that restores the app from the background without
    // reloading, can therefore run a build for days after it was replaced.
    //
    // That is how a shipped fix goes unnoticed: the deploy is correct, the
    // server serves the new bundle, and the device keeps the old one because
    // nothing ever asked. Check on a timer and whenever the tab comes back to
    // the foreground, so the update prompt actually appears.
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const check = () => {
        // Pointless while offline, and it would only log a failed fetch.
        if (navigator.onLine) void registration.update();
      };
      const onVisible = () => {
        if (document.visibilityState === 'visible') check();
      };

      const interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener('visibilitychange', onVisible);
      // Deliberately not cleaned up: this registration lives as long as the
      // page does, and the provider is mounted once at the root.
      window.addEventListener('pagehide', () => {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisible);
      });
    },
    onRegisterError(error) {
      console.error('Service worker registration failed', error);
    },
  });

  useEffect(() => {
    const onInstalled = () => {
      setIsStandalone(true);
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const value = useMemo<PwaContextValue>(
    () => ({
      isStandalone,
      needsManualInstall: !isStandalone && isIosInstallPlatform(),
    }),
    [isStandalone],
  );

  return (
    <PwaContext.Provider value={value}>
      {children}
      <PwaStatus
        isOnline={isOnline}
        needRefresh={needRefresh}
        offlineReady={offlineReady}
        onUpdate={() => void updateServiceWorker(true)}
        onDismissUpdate={() => {
          setNeedRefresh(false);
          // The worker is still waiting; ask again shortly rather than
          // pretending the update went away.
          window.setTimeout(() => setNeedRefresh(true), UPDATE_SNOOZE_MS);
        }}
        onDismissReady={() => setOfflineReady(false)}
        hasMobileTabs={authenticated}
      />
    </PwaContext.Provider>
  );
}

interface PwaStatusProps {
  isOnline: boolean;
  needRefresh: boolean;
  offlineReady: boolean;
  onUpdate: () => void;
  onDismissUpdate: () => void;
  onDismissReady: () => void;
  hasMobileTabs?: boolean;
}

export function PwaStatus({
  isOnline,
  needRefresh,
  offlineReady,
  onUpdate,
  onDismissUpdate,
  onDismissReady,
  hasMobileTabs = false,
}: PwaStatusProps) {
  const t = useT();
  const state = !isOnline
    ? 'offline'
    : needRefresh
      ? 'update'
      : offlineReady
        ? 'ready'
        : null;
  if (!state) return null;

  return (
    <aside
      role={state === 'update' ? 'alert' : 'status'}
      aria-live={state === 'update' ? 'assertive' : 'polite'}
      className={`fixed inset-x-4 z-[70] mx-auto flex min-h-14 max-w-sm items-center gap-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] px-4 py-3 text-[hsl(var(--popover-foreground))] shadow-xl ${
        hasMobileTabs
          ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))] md:bottom-[calc(1rem+env(safe-area-inset-bottom))]'
          : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]'
      }`}
    >
      {state === 'offline' ? (
        <CloudOff className="h-5 w-5 shrink-0 text-[hsl(var(--muted-foreground))]" />
      ) : state === 'update' ? (
        <RefreshCw className="h-5 w-5 shrink-0 text-[hsl(var(--primary))]" />
      ) : (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
      )}

      <p className="min-w-0 flex-1 text-sm font-medium">
        {state === 'offline'
          ? t('pwa.offline')
          : state === 'update'
            ? t('pwa.updateReady')
            : t('pwa.offlineReady')}
      </p>

      {state === 'update' && (
        <button
          type="button"
          onClick={onUpdate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-3 text-sm font-medium text-[hsl(var(--primary-foreground))]"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('pwa.update')}
        </button>
      )}

      {state !== 'offline' && (
        <button
          type="button"
          onClick={state === 'update' ? onDismissUpdate : onDismissReady}
          aria-label={t('banner.dismiss')}
          title={t('banner.dismiss')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </aside>
  );
}
