import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  type ErrorBoundaryProps,
  router,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/constants/theme';
import {
  MobileErrorBoundary,
  MobileErrorFallback,
} from '@/components/mobile-error-boundary';
import { OfflineBanner } from '@/components/offline-banner';
import { captureClientError, installGlobalErrorHandler } from '@/lib/client-errors';
import { hydrateSession } from '@/lib/session';
import {
  installReleaseNotificationHandler,
  installReleaseNotificationResponseHandler,
} from '@/lib/release-notifications';
import { AppProviders } from '@/providers/app-providers';
import { useT } from '@/hooks/use-t';
import { hasLocalSession, useAuthStore } from '@/store/auth';

void SplashScreen.preventAutoHideAsync();
installReleaseNotificationHandler();

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    void captureClientError(error, { isFatal: true });
  }, [error]);

  return <MobileErrorFallback onRetry={() => void retry()} />;
}

export default function RootLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = colors[scheme];
  const t = useT();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrateSession()
      .finally(() => setReady(true));
  }, []);

  useEffect(() => installGlobalErrorHandler(), []);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    return installReleaseNotificationResponseHandler((route) => {
      const auth = useAuthStore.getState();
      if (hasLocalSession(auth.status)) router.push(route);
    });
  }, [ready]);

  if (!ready) return null;

  const navigationTheme = scheme === 'dark'
    ? {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: theme.background,
          card: theme.elevated,
          border: theme.border,
          text: theme.text,
          primary: theme.primary,
        },
      }
    : {
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: theme.background,
          card: theme.elevated,
          border: theme.border,
          text: theme.text,
          primary: theme.primary,
        },
      };

  return (
    <AppProviders>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <MobileErrorBoundary>
          <View style={{ flex: 1 }}>
            <OfflineBanner />
            <Stack
              screenOptions={{
                contentStyle: { backgroundColor: theme.background },
                headerStyle: { backgroundColor: theme.elevated },
                headerTintColor: theme.text,
                headerShadowVisible: false,
                headerBackButtonDisplayMode: 'minimal',
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="reset-password" options={{ headerShown: false }} />
              <Stack.Screen name="media/[id]" options={{ title: t('screens.details') }} />
              <Stack.Screen name="episodes/[id]" options={{ title: t('screens.episode') }} />
              <Stack.Screen name="notifications" options={{ title: t('screens.notifications') }} />
              <Stack.Screen name="statistics" options={{ title: t('screens.statistics') }} />
              <Stack.Screen name="wrapped" options={{ title: t('screens.wrapped') }} />
              <Stack.Screen name="history" options={{ title: t('screens.history') }} />
              <Stack.Screen name="lists" options={{ title: t('screens.lists') }} />
              <Stack.Screen name="lists/[id]" options={{ title: t('screens.list') }} />
              <Stack.Screen name="social" options={{ title: t('screens.social') }} />
              <Stack.Screen name="people/[username]" options={{ title: t('screens.profile') }} />
              <Stack.Screen name="profile/[username]" options={{ title: t('screens.profile') }} />
              <Stack.Screen name="settings" options={{ title: t('screens.settings') }} />
              <Stack.Screen name="import-tvtime" options={{ title: t('screens.importData') }} />
            </Stack>
          </View>
        </MobileErrorBoundary>
      </ThemeProvider>
    </AppProviders>
  );
}
