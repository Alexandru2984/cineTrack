import { useEffect } from 'react';

const BASE = 'Văzute';
const DEFAULT_TITLE = `${BASE} — track what you watch`;

/**
 * Set the document title for the current page ("<title> — Văzute"), restoring
 * the default on unmount. Improves browser tabs and any unfurler that runs JS;
 * static crawlers still read the Open Graph tags baked into index.html.
 */
export function usePageTitle(title?: string | null) {
  useEffect(() => {
    document.title = title ? `${title} — ${BASE}` : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
