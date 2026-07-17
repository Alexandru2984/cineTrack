import { Redirect, Stack } from 'expo-router';

import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function AuthLayout() {
  const status = useAuthStore((state) => state.status);
  if (hasLocalSession(status)) return <Redirect href="/(tabs)" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
