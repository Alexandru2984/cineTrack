import { Redirect, Stack, useLocalSearchParams } from 'expo-router';

import { safePostAuthRedirect } from '@/lib/deep-links';
import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function AuthLayout() {
  const status = useAuthStore((state) => state.status);
  const params = useLocalSearchParams<{ redirect?: string | string[] }>();
  const redirect = safePostAuthRedirect(params.redirect);
  if (hasLocalSession(status)) return <Redirect href={redirect ?? '/(tabs)'} />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
