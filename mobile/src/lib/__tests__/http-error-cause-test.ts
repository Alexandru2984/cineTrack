import { ApiError } from '@/lib/http';

describe('ApiError', () => {
  // A rejected upload used to arrive as "Could not connect to Văzute" with
  // nothing behind it. The native layer had said exactly why it could not build
  // the request, the fetch polyfill replaced that with "Network request failed",
  // and this class replaced it again. Two features shipped broken because the
  // reason was unrecoverable by the time anyone could read it.
  it('keeps the failure it wraps', () => {
    const underlying = new TypeError('Network request failed');
    const error = new ApiError('Could not connect to Văzute', 0, undefined, {
      cause: underlying,
    });

    expect(error.cause).toBe(underlying);
    expect(error.status).toBe(0);
    expect(error.message).toBe('Could not connect to Văzute');
  });

  it('stays usable without one', () => {
    const error = new ApiError('Not found', 404, { message: 'Not found' });

    expect(error.cause).toBeUndefined();
    expect(error.payload).toEqual({ message: 'Not found' });
  });
});
