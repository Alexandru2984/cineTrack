import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { CheckCircle2, CloudOff, RefreshCw, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { PwaContext, type PwaContextValue } from '@/hooks/usePwaInstall';
import { useAuthStore } from '@/store/auth';

interface InstallChoice {
  outcome: 'accepted' | 'dismissed';
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
}

function standaloneMode(): boolean {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches
    || iosNavigator.standalone === true;
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(standaloneMode);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError(error) {
      console.error('Service worker registration failed', error);
    },
  });

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setIsStandalone(true);
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const install = useCallback(async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch (error) {
      console.error('App install prompt failed', error);
    } finally {
      setInstallPrompt(null);
    }
  }, [installPrompt]);

  const value = useMemo<PwaContextValue>(
    () => ({
      canInstall: !isStandalone && installPrompt !== null,
      install,
      isStandalone,
    }),
    [install, installPrompt, isStandalone],
  );

  return (
    <PwaContext.Provider value={value}>
      {children}
      <PwaStatus
        isOnline={isOnline}
        needRefresh={needRefresh}
        offlineReady={offlineReady}
        onUpdate={() => void updateServiceWorker(true)}
        onDismissUpdate={() => setNeedRefresh(false)}
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
          ? 'You are offline'
          : state === 'update'
            ? 'A new version is ready'
            : 'Ready for offline launch'}
      </p>

      {state === 'update' && (
        <button
          type="button"
          onClick={onUpdate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-3 text-sm font-medium text-white"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Update
        </button>
      )}

      {state !== 'offline' && (
        <button
          type="button"
          onClick={state === 'update' ? onDismissUpdate : onDismissReady}
          aria-label="Dismiss"
          title="Dismiss"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </aside>
  );
}
