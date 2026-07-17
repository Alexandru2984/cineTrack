import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiError } from '@/lib/http';
import {
  clearClientErrorReports,
  flushClientErrorReports,
} from '@/lib/client-errors';
import { PERSISTED_QUERY_ROOTS } from '@/lib/query-cache-policy';
import {
  QUERY_CACHE_BUSTER,
  QUERY_CACHE_MAX_AGE,
  queryDehydrateOptions,
  queryPersister,
} from '@/lib/query-persistence';
import {
  flushPendingPushRevocations,
  syncReleaseNotifications,
} from '@/lib/release-notifications';
import { resumeOfflineSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

function refreshReleaseNotifications() {
  void flushPendingPushRevocations().catch(() => undefined);
  const auth = useAuthStore.getState();
  if (auth.status === 'authenticated' && auth.user) {
    void syncReleaseNotifications(auth.user.id).catch(() => undefined);
  }
}

export function AppProviders({ children }: PropsWithChildren) {
  const userId = useAuthStore((state) => state.user?.id);
  const [queryClient] = useState(
    () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) =>
              failureCount < 1 && (!(error instanceof ApiError) || error.status >= 500),
          },
          mutations: { retry: false, networkMode: 'always' },
        },
      });
      for (const root of PERSISTED_QUERY_ROOTS) {
        client.setQueryDefaults([root], { gcTime: QUERY_CACHE_MAX_AGE });
      }
      return client;
    },
  );

  useEffect(() => {
    refreshReleaseNotifications();
    const subscription = AppState.addEventListener('change', (state) => {
      focusManager.setFocused(state === 'active');
      if (state === 'active') {
        void flushClientErrorReports();
        refreshReleaseNotifications();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let resuming = false;
    let disposed = false;
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected === null) return;
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      const auth = useAuthStore.getState();
      if (!connected) {
        onlineManager.setOnline(false);
        if (auth.status === 'authenticated') auth.enterOfflineMode();
        return;
      }

      if (auth.status !== 'offline') {
        onlineManager.setOnline(true);
        if (auth.status === 'authenticated') {
          void flushClientErrorReports();
          refreshReleaseNotifications();
        }
        return;
      }

      onlineManager.setOnline(false);
      if (resuming) return;
      resuming = true;
      void resumeOfflineSession().finally(() => {
        resuming = false;
        if (!disposed) {
          const authenticated = useAuthStore.getState().status === 'authenticated';
          onlineManager.setOnline(authenticated);
          if (authenticated) {
            void flushClientErrorReports();
            refreshReleaseNotifications();
          }
        }
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const clearCache = () => {
      queryClient.clear();
      void Promise.all([
        queryPersister.removeClient(),
        clearClientErrorReports(),
      ]);
    };
    const initialStatus = useAuthStore.getState().status;
    if (initialStatus === 'anonymous') clearCache();
    if (initialStatus === 'authenticated') {
      void flushClientErrorReports();
      refreshReleaseNotifications();
    }

    return useAuthStore.subscribe((state, previousState) => {
      const accountChanged = state.user?.id !== previousState.user?.id;
      const signedOut =
        state.status === 'anonymous' && previousState.status !== 'anonymous';
      if ((accountChanged && previousState.user) || signedOut) {
        clearCache();
      }
      if (signedOut) {
        void flushPendingPushRevocations().catch(() => undefined);
      } else if (
        state.status === 'authenticated' &&
        (previousState.status !== 'authenticated' || accountChanged) &&
        state.user
      ) {
        void flushClientErrorReports();
        void syncReleaseNotifications(state.user.id).catch(() => undefined);
      }
    });
  }, [queryClient]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          key={userId ?? 'anonymous'}
          client={queryClient}
          persistOptions={{
            persister: queryPersister,
            maxAge: QUERY_CACHE_MAX_AGE,
            buster: `${QUERY_CACHE_BUSTER}:${userId ?? 'anonymous'}`,
            dehydrateOptions: queryDehydrateOptions,
          }}
        >
          {children}
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
