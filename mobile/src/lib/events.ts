/**
 * Client for the server-sent event stream.
 *
 * Built on `expo/fetch` rather than the React Native global. RN's `fetch` has no
 * streaming response body — reading it waits for the whole response, which for a
 * connection that never ends means it never resolves. `expo/fetch` exposes a
 * real `ReadableStream`, so this needs no extra dependency.
 *
 * The events carry no content, only which area changed, so every handler does
 * the same thing: refetch through the normal authenticated endpoint. That keeps
 * one authorization path and makes a dropped event cost a delayed refresh rather
 * than a missing message.
 */

import { fetch as expoFetch } from 'expo/fetch';

import { API_BASE_URL } from '@/lib/config';
import { refreshSession } from '@/lib/session';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export type ServerEventKind = 'messages' | 'notifications';

export interface EventStreamHandlers {
  onEvent: (kind: ServerEventKind) => void;
  /** Called whenever a stream starts, including after a reconnect. The client
   *  cannot know what it missed while disconnected, so this is the signal to
   *  refetch everything the stream would otherwise have reported. */
  onResync: () => void;
}

/** Parse one SSE frame. Comment lines (`:` prefixed) are keepalives and carry
 *  no event, so they yield null. */
export function parseFrame(frame: string): ServerEventKind | null {
  let name: string | null = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
  }
  return name === 'messages' || name === 'notifications' ? name : null;
}

/**
 * Hold a stream open, reconnecting with backoff until the returned function is
 * called.
 *
 * The caller decides when a stream should exist at all. On a phone that means
 * only while the app is in the foreground: iOS suspends network activity behind
 * the app switcher, so a connection held there delivers nothing and costs
 * battery and a socket for as long as it survives.
 */
export function connectEventStream(
  getToken: () => string | null,
  handlers: EventStreamHandlers,
  refreshToken: () => Promise<unknown> = refreshSession,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (stopped) return;
    // Exponential with a ceiling: a backend restart must not turn every
    // installed app into a tight retry loop against a service still starting.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    timer = setTimeout(() => void run(), delay);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    const token = getToken();
    if (!token) return schedule();

    controller = new AbortController();
    try {
      const response = await expoFetch(`${API_BASE_URL}/api/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (response.status === 401) {
        // The access token expired while the stream was open, or between a
        // reconnect and this attempt. Retrying with the same token cannot
        // succeed: this request is made directly with `expo/fetch` and never
        // passes through the client in `lib/api`, which is what refreshes.
        //
        // Without this the stream sat in a 401 loop at the backoff ceiling
        // until some unrelated query happened to refresh the session — a phone
        // waking its radio every thirty seconds to be told no, and messages
        // arriving only when something else asked. The web client already
        // handles this; this copy never did.
        try {
          await refreshToken();
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

      // Connected. Whatever happened while disconnected is unknown, so resync
      // before processing the first frame.
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
          // `: lagged` means the server dropped signals for this connection. It
          // cannot say which, so treat it like a reconnect.
          if (frame.startsWith(': lagged')) {
            handlers.onResync();
            continue;
          }
          const kind = parseFrame(frame);
          if (kind) handlers.onEvent(kind);
        }
      }
    } catch {
      // Network change, backgrounding, or an aborted request. Backoff handles it.
    }
    return schedule();
  };

  void run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller?.abort();
  };
}
