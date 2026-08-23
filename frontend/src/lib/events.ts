/**
 * Client for the server-sent event stream.
 *
 * Built on `fetch` rather than `EventSource`, because `EventSource` cannot send
 * an `Authorization` header. The usual workaround is a token in the query
 * string, which is exactly what this codebase avoids elsewhere: query strings
 * reach access logs, `Referer` headers and browser history.
 *
 * The events carry no content — only which area changed — so every handler here
 * does the same thing: invalidate and refetch through the normal authenticated
 * endpoints. That keeps one authorization path and makes a dropped event cost a
 * delayed refresh rather than a missing message.
 */

import { refreshAccessToken } from '@/lib/api';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type ServerEventKind = 'messages' | 'notifications';

export interface EventStreamHandlers {
  onEvent: (kind: ServerEventKind) => void;
  /** Called whenever a stream starts, including after a reconnect. The client
   *  cannot know what it missed while disconnected, so this is the signal to
   *  refetch everything the stream would otherwise have told it about. */
  onResync: () => void;
}

/** Parse one SSE frame. Comment lines (`:` prefixed) are keepalives and carry
 *  no event, so they yield null. */
function parseFrame(frame: string): ServerEventKind | null {
  let name: string | null = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
  }
  return name === 'messages' || name === 'notifications' ? name : null;
}

/**
 * Hold a stream open, reconnecting with backoff until `stop` is called.
 *
 * Returns a stop function. Reconnection is unconditional by design: the server
 * closes the stream when a session is revoked, and the retry that follows will
 * fail authentication and surface through the normal 401 path rather than
 * looping silently.
 */
export function connectEventStream(
  apiUrl: string,
  getToken: () => string | null,
  handlers: EventStreamHandlers,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async (): Promise<void> => {
    const token = getToken();
    if (!token) return schedule();

    controller = new AbortController();
    try {
      const response = await fetch(`${apiUrl}/api/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        credentials: 'include',
      });
      if (response.status === 401) {
        // The access token expired while the stream was open, or between a
        // reconnect and this attempt. Retrying with the same token cannot
        // succeed: this request never touches the axios interceptor that
        // refreshes, because a streaming body is not something axios returns.
        //
        // Without this the stream sat in a 401 loop every thirty seconds until
        // some unrelated query happened to refresh the session — which is
        // exactly what a backend restart produced, in every open tab at once.
        try {
          await refreshAccessToken();
        } catch {
          // The session is genuinely gone. Back off rather than hammer.
          return schedule();
        }
        // A refreshed session is not a failed attempt; reconnect promptly
        // rather than waiting out a backoff earned by something else.
        attempt = 0;
        return schedule();
      }
      if (!response.ok || !response.body) return schedule();

      // Connected. Anything that happened while disconnected is unknown, so
      // resync before processing the first frame.
      attempt = 0;
      handlers.onResync();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; anything after the last one is
        // a partial frame and stays buffered.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          // A `: lagged` comment means the server dropped signals for this
          // connection. It cannot say which, so treat it like a reconnect.
          if (frame.startsWith(': lagged')) {
            handlers.onResync();
            continue;
          }
          const kind = parseFrame(frame);
          if (kind) handlers.onEvent(kind);
        }
      }
    } catch {
      // Network error, navigation, or an aborted request. Backoff handles it.
    }
    return schedule();
  };

  const schedule = (): void => {
    if (stopped) return;
    // Exponential with a ceiling, so a backend restart does not turn every open
    // tab into a tight retry loop against a service that is still starting.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    timer = setTimeout(() => void run(), delay);
  };

  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
