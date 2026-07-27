import { Redirect } from 'expo-router';

import { ErrorState, LoadingState } from '@/components/screen-state';
import { useT } from '@/hooks/use-t';
import { hydrateSession } from '@/lib/session';
import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function HomeScreen() {
  const status = useAuthStore((state) => state.status);
  const t = useT();
  if (status === 'loading') return <LoadingState label={t('session.restoring')} />;
  if (status === 'restore_error') {
    return (
      <ErrorState
        message={t('session.restoreError')}
        onRetry={() => void hydrateSession()}
      />
    );
  }
  return <Redirect href={hasLocalSession(status) ? '/(tabs)' : '/(auth)/login'} />;
}
