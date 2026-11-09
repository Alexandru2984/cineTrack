import { rawRequest } from '@/lib/http';

jest.mock('@/lib/config', () => ({ API_BASE_URL: 'https://example.test/api' }));

function respond(status: number, body: string) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
}

describe('rawRequest response types', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns a file body as it came when asked for text', async () => {
    const csv = '﻿tmdb_id,title\r\n1,"Up, again"\r\n';
    const fetchMock = respond(200, csv);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(rawRequest('/tracking/export', { responseType: 'text' })).resolves.toBe(csv);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Accept: '*/*' });
  });

  it('still reads the message of a failed text request', async () => {
    globalThis.fetch = respond(400, '{"message":"Unknown sort"}') as unknown as typeof fetch;

    await expect(
      rawRequest('/tracking/export', { responseType: 'text' }),
    ).rejects.toMatchObject({ status: 400, message: 'Unknown sort' });
  });

  it('parses JSON by default', async () => {
    globalThis.fetch = respond(200, '{"total":3}') as unknown as typeof fetch;

    await expect(rawRequest('/tracking/facets')).resolves.toEqual({ total: 3 });
  });
});
