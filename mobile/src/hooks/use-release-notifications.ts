import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from '@/lib/http';
import {
  disableReleaseNotifications,
  enableReleaseNotifications,
  getReleaseNotificationState,
  type ReleaseNotificationState,
} from '@/lib/release-notifications';

const initialState: ReleaseNotificationState = {
  enabled: false,
  pending: false,
  permission: 'undetermined',
  canAskAgain: true,
};

export function useReleaseNotifications(ownerId: string, active = true) {
  const [state, setState] = useState(initialState);
  const [isLoading, setIsLoading] = useState(active);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!active || !ownerId) return;
    setIsLoading(true);
    try {
      setState(await getReleaseNotificationState(ownerId));
      setError(null);
    } catch (reason) {
      setError(getErrorMessage(reason, 'Could not load release alerts'));
    } finally {
      setIsLoading(false);
    }
  }, [active, ownerId]);

  useEffect(() => {
    if (!active || !ownerId) return;
    let cancelled = false;
    void getReleaseNotificationState(ownerId)
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(getErrorMessage(reason, 'Could not load release alerts'));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, ownerId]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!ownerId) return;
    setIsUpdating(true);
    setError(null);
    try {
      const nextState = enabled
        ? await enableReleaseNotifications(ownerId)
        : await disableReleaseNotifications(ownerId);
      setState(nextState);
    } catch (reason) {
      setError(getErrorMessage(reason, 'Could not update release alerts'));
      try {
        setState(await getReleaseNotificationState(ownerId));
      } catch {
        // Preserve the last known state when secure storage is unavailable.
      }
    } finally {
      setIsUpdating(false);
    }
  }, [ownerId]);

  return { state, isLoading, isUpdating, error, refresh, setEnabled };
}
