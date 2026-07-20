import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

import type { AppStateStatus } from 'react-native';

const GUARD_TAG = 'vazute-sensitive-screen';

/**
 * Whether a secret on screen should be hidden right now.
 *
 * iOS takes its app-switcher snapshot while the app is `inactive`, not only
 * once it reaches `background`, so anything other than `active` has to hide.
 * With nothing sensitive on screen there is nothing to hide, whatever the app
 * state is.
 */
export function shouldConceal(active: boolean, appState: AppStateStatus): boolean {
  return active && appState !== 'active';
}

/**
 * Protect a screen that is showing a secret — the 2FA setup key or the recovery
 * codes, both of which bypass a password.
 *
 * Two defences, because neither covers the whole problem:
 *
 * 1. `preventScreenCaptureAsync` sets FLAG_SECURE on Android, which blocks
 *    screenshots *and* blanks the thumbnail the system keeps for the app
 *    switcher. On iOS it does not stop either of those — it only applies to
 *    screen recording.
 * 2. So the caller also gets `concealed`, which flips as the app leaves the
 *    foreground. Hiding the secret before the OS takes its snapshot is what
 *    keeps the recovery codes out of that cached image on iOS, and it is the
 *    exact moment it matters: the user backgrounds the app to paste the codes
 *    into a password manager.
 *
 * Returns whether the content should currently be hidden.
 */
export function useSensitiveScreen(active: boolean): boolean {
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!active) return;

    void ScreenCapture.preventScreenCaptureAsync(GUARD_TAG).catch(() => {
      // Losing the native guard must not take the screen down with it; the
      // conceal-on-background half below still applies.
    });

    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
    });

    return () => {
      subscription.remove();
      void ScreenCapture.allowScreenCaptureAsync(GUARD_TAG).catch(() => undefined);
    };
  }, [active]);

  return shouldConceal(active, appState);
}
