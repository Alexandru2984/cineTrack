import { useCallback } from 'react';

import { translate } from '@/lib/i18n';
import { useLocaleStore } from '@/store/locale';

/**
 * Returns a `t(key, params?)` function bound to the current locale. Components
 * re-render on locale changes because they subscribe to the store here.
 */
export function useT() {
  const locale = useLocaleStore((state) => state.locale);
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  );
}
