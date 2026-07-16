import { Redirect } from 'expo-router';

import { LoadingState } from '@/components/screen-state';
import { useAuthStore } from '@/store/auth';

export default function HomeScreen() {
  const status = useAuthStore((state) => state.status);
  if (status === 'loading') return <LoadingState label="Restoring session" />;
  return <Redirect href={status === 'authenticated' ? '/(tabs)' : '/(auth)/login'} />;
}
