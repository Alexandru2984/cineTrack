import { Redirect, Stack } from 'expo-router';

import { useAuthStore } from '@/store/auth';

export default function AuthLayout() {
  const status = useAuthStore((state) => state.status);
  if (status === 'authenticated') return <Redirect href="/(tabs)" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
