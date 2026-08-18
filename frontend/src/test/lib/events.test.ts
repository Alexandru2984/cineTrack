import { describe, expect, it, vi } from 'vitest';
import { connectEventStream } from '@/lib/events';

/** Build a Response whose body streams the given chunks, then ends. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collect(chunks: string[]) {
  const events: string[] = [];
  let resyncs = 0;
  const fetchMock = vi.fn().mockResolvedValueOnce(streamingResponse(chunks))
    // Any reconnect after the first stream ends hangs, so the test observes
    // exactly one pass rather than racing the backoff timer.
    .mockImplementation(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetchMock);

  const stop = connectEventStream('https://api.test', () => 'token', {
    onEvent: (kind) => events.push(kind),
    onResync: () => { resyncs += 1; },
  });

  // Let the stream be read to completion.
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  vi.unstubAllGlobals();
  return { events, resyncs, fetchMock };
}

describe('connectEventStream', () => {
  it('sends the access token as a header, never in the URL', async () => {
    const { fetchMock } = await collect([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // A token in the query string reaches access logs, Referer headers and
    // browser history — the reason this uses fetch rather than EventSource.
    expect(url).toBe('https://api.test/api/events');
    expect(url).not.toContain('token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('reports each event kind once', async () => {
    const { events } = await collect([
      'event: messages\ndata: {"kind":"messages"}\n\n',
      'event: notifications\ndata: {"kind":"notifications"}\n\n',
    ]);
    expect(events).toEqual(['messages', 'notifications']);
  });

  it('reassembles a frame split across chunks', async () => {
    // The network decides where chunks break, not the server; a frame cut in
    // half must not be dropped or double-counted.
    const { events } = await collect(['event: mess', 'ages\ndata: {"kind":"messages"}\n\n']);
    expect(events).toEqual(['messages']);
  });

  it('ignores keepalive comments', async () => {
    const { events, resyncs } = await collect([': keepalive\n\n']);
    expect(events).toEqual([]);
    // One resync for the connect itself, and nothing from the comment.
    expect(resyncs).toBe(1);
  });

  it('treats a lag notice as a reason to refetch everything', async () => {
    // The server cannot say which signals it dropped, so the only honest
    // recovery is a full resync.
    const { events, resyncs } = await collect([': lagged\n\n']);
    expect(events).toEqual([]);
    expect(resyncs).toBe(2);
  });

  it('resyncs on connect, because it cannot know what it missed', async () => {
    const { resyncs } = await collect(['event: messages\ndata: {"kind":"messages"}\n\n']);
    expect(resyncs).toBe(1);
  });

  it('does not connect without a token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const stop = connectEventStream('https://api.test', () => null, {
      onEvent: () => {},
      onResync: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
