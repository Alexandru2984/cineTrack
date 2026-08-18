import { parseFrame } from '@/lib/events';

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
