import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/constants/theme';
import { OfflineBanner } from '@/components/offline-banner';
import { hydrateSession } from '@/lib/session';
import { AppProviders } from '@/providers/app-providers';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = colors[scheme];
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrateSession()
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
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
            <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
            <Stack.Screen name="statistics" options={{ title: 'Statistics' }} />
            <Stack.Screen name="history" options={{ title: 'Watch history' }} />
            <Stack.Screen name="lists" options={{ title: 'Custom lists' }} />
            <Stack.Screen name="lists/[id]" options={{ title: 'List' }} />
            <Stack.Screen name="social" options={{ title: 'Social' }} />
            <Stack.Screen name="people/[username]" options={{ title: 'Profile' }} />
            <Stack.Screen name="settings" options={{ title: 'Account settings' }} />
          </Stack>
        </View>
      </ThemeProvider>
    </AppProviders>
  );
}
