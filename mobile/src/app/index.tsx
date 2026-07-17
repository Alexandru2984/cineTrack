import { Redirect } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/screen-state';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function HomeScreen() {
  const status = useAuthStore((state) => state.status);
  if (status === 'loading') return <LoadingState label="Restoring session" />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message="Your session is still saved. Check your connection and try again."
        onRetry={() => void hydrateSession()}
      />
    );
  }
  return <Redirect href={hasLocalSession(status) ? '/(tabs)' : '/(auth)/login'} />;
}
