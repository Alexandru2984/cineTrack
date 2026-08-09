import { useEffect } from 'react';

/**
 * Ask search engines to leave the current page out of their index.
 *
 * A single-page app answers every address with 200 and its own shell, so a
 * mistyped URL looks to a crawler like a real, if empty, page — a soft 404.
 * The proper fix is a genuine 404 status, which the client cannot send, so
 * this is the documented fallback: say plainly that the page should not be
 * indexed.
 *
 * The tag is removed on unmount, otherwise navigating away from a missing page
 * would leave the whole app marked noindex.
 */
export function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}
