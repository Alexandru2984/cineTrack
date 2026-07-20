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
              <Stack.Screen name="media/[id]" options={{ title: 'Details' }} />
              <Stack.Screen name="episodes/[id]" options={{ title: 'Episode' }} />
              <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
              <Stack.Screen name="statistics" options={{ title: 'Statistics' }} />
              <Stack.Screen name="history" options={{ title: 'Watch history' }} />
              <Stack.Screen name="lists" options={{ title: 'Custom lists' }} />
              <Stack.Screen name="lists/[id]" options={{ title: 'List' }} />
              <Stack.Screen name="social" options={{ title: 'Social' }} />
              <Stack.Screen name="people/[username]" options={{ title: 'Profile' }} />
              <Stack.Screen name="profile/[username]" options={{ title: 'Profile' }} />
              <Stack.Screen name="settings" options={{ title: 'Account settings' }} />
            </Stack>
          </View>
        </MobileErrorBoundary>
      </ThemeProvider>
    </AppProviders>
  );
}
