import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { type PropsWithChildren, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ApiError } from '@/lib/http';
import { PERSISTED_QUERY_ROOTS } from '@/lib/query-cache-policy';
import {
  QUERY_CACHE_BUSTER,
  QUERY_CACHE_MAX_AGE,
  queryDehydrateOptions,
  queryPersister,
} from '@/lib/query-persistence';
import { resumeOfflineSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

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
    const subscription = AppState.addEventListener('change', (state) => {
      focusManager.setFocused(state === 'active');
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
        return;
      }

      onlineManager.setOnline(false);
      if (resuming) return;
      resuming = true;
      void resumeOfflineSession().finally(() => {
        resuming = false;
        if (!disposed) {
          onlineManager.setOnline(
            useAuthStore.getState().status === 'authenticated',
          );
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
      void queryPersister.removeClient();
    };
    if (useAuthStore.getState().status === 'anonymous') clearCache();

    return useAuthStore.subscribe((state, previousState) => {
      const accountChanged = state.user?.id !== previousState.user?.id;
      const signedOut =
        state.status === 'anonymous' && previousState.status !== 'anonymous';
      if ((accountChanged && previousState.user) || signedOut) clearCache();
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
