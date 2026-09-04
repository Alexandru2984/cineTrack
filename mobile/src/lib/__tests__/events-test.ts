import { connectEventStream, parseFrame } from '@/lib/events';

describe('parseFrame', () => {
  it('names each event kind', () => {
    expect(parseFrame('event: messages\ndata: {"kind":"messages"}')).toBe('messages');
    expect(parseFrame('event: notifications\ndata: {"kind":"notifications"}')).toBe(
      'notifications',
    );
  });

  it('ignores keepalive comments', () => {
    // Comment frames keep proxies from reaping an idle connection and carry no
    // event; treating one as an event would refetch on every heartbeat.
    expect(parseFrame(': keepalive')).toBeNull();
    expect(parseFrame(': lagged')).toBeNull();
  });

  it('ignores an unknown event name', () => {
    // A newer server may send a kind this build does not handle. Refetching
    // everything on an unrecognised name would be a silent extra request per
    // event, so it is dropped instead.
    expect(parseFrame('event: something-new\ndata: {}')).toBeNull();
  });

  it('reads the event name regardless of field order', () => {
    expect(parseFrame('data: {"kind":"messages"}\nevent: messages')).toBe('messages');
  });

  it('returns null for a frame with no event line', () => {
    expect(parseFrame('data: {"kind":"messages"}')).toBeNull();
    expect(parseFrame('')).toBeNull();
  });
});

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/session', () => ({ refreshSession: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fetch: mockFetch } = require('expo/fetch') as { fetch: jest.Mock };

describe('connectEventStream', () => {
  const noop = { onEvent: jest.fn(), onResync: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function answerWith(...statuses: number[]) {
    for (const status of statuses) {
      mockFetch.mockImplementationOnce(async () => ({
        status,
        ok: status < 400,
        body: null,
      }));
    }
    mockFetch.mockImplementation(async () => ({ status: 500, ok: false, body: null }));
  }

  // Two microtask turns: one for the fetch, one for the branch that follows it.
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('refreshes the session when the stream is refused, instead of looping on a dead token', async () => {
    // The bug this covers: a 401 was handled like any other failure, so the
    // phone reconnected at the backoff ceiling every thirty seconds with the
    // same expired token, for as long as it took some unrelated query to
    // refresh the session. Messages arrived late and the radio woke for
    // nothing. The web client already did this; this copy never did.
    answerWith(401);
    const refresh = jest.fn(async () => 'fresh-token');

    const stop = connectEventStream(() => 'stale-token', noop, refresh);
    await settle();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not refresh on a failure that is not an authorization one', async () => {
    // A 503 says the server is unwell, not that the token is. Refreshing on
    // every such failure would spend a refresh token on a backend restart.
    answerWith(503);
    const refresh = jest.fn(async () => 'fresh-token');

    const stop = connectEventStream(() => 'good-token', noop, refresh);
    await settle();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it('backs off rather than hammering when the refresh itself fails', async () => {
    // The session is genuinely gone. Retrying immediately would be a tight loop
    // against an endpoint that has already said no.
    answerWith(401);
    const refresh = jest.fn(async () => {
      throw new Error('no refresh token');
    });

    const stop = connectEventStream(() => 'stale-token', noop, refresh);
    await settle();

    expect(refresh).toHaveBeenCalledTimes(1);
    // Nothing retried inside the same tick; the next attempt is on a timer.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never opens a stream without a token', async () => {
    answerWith(200);
    const refresh = jest.fn(async () => 'fresh-token');

    const stop = connectEventStream(() => null, noop, refresh);
    await settle();

    expect(mockFetch).not.toHaveBeenCalled();
    stop();
  });
});
