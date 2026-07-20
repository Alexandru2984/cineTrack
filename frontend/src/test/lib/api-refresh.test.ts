import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';

/**
 * Exercises the real response interceptor in `lib/api`, not a copy of its
 * logic. Requests go through a stub axios adapter so the interceptor chain runs
 * exactly as it does in the browser, and the refresh endpoint is spied on
 * separately because it is called with the bare axios instance.
 *
 * The single-flight case is the one with teeth: the backend revokes an entire
 * token family when it sees a refresh token reused, so if concurrent 401s each
 * started their own rotation the user would be signed out everywhere.
 */

// The interceptor keeps `refreshPromise` and `refreshUnavailable` at module
// scope, so every case needs a freshly imported module to start from zero.
async function loadApi(options: {
  onRequest: AxiosAdapter;
  refresh: () => Promise<unknown>;
}) {
  vi.resetModules();

  const axios = (await import('axios')).default;
  const refreshSpy = vi.fn(options.refresh);
  vi.spyOn(axios, 'post').mockImplementation(refreshSpy as never);

  const { useAuthStore } = await import('@/store/auth');
  useAuthStore.setState({
    token: 'stale-access-token',
    user: null,
    status: 'authenticated',
  } as never);

  const api = (await import('@/lib/api')).default;
  api.defaults.adapter = options.onRequest;

  return { api, refreshSpy, useAuthStore };
}

// The interceptor retries by re-issuing `error.config`, so the stub has to hand
// back the request's real config rather than a fresh object — otherwise the
// retry path has nothing to work with and silently does nothing.
function respond(
  config: Parameters<AxiosAdapter>[0],
  status: number,
  data: unknown = {},
): ReturnType<AxiosAdapter> {
  config.headers = config.headers ?? ({} as never);
  return status >= 400
    ? Promise.reject(
        Object.assign(new Error(`status ${status}`), {
          isAxiosError: true,
          config,
          response: { status, data, config, headers: {}, statusText: '' },
        }),
      )
    : Promise.resolve({ data, status, statusText: 'OK', headers: {}, config });
}

describe('access token refresh interceptor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshes once for concurrent 401s instead of starting a rotation each', async () => {
    let refreshed = false;
    const { api, refreshSpy } = await loadApi({
      refresh: async () => {
        // Hold the refresh open so all three requests queue behind this one.
        await new Promise((resolve) => setTimeout(resolve, 10));
        refreshed = true;
        return { data: { access_token: 'fresh', user: { id: 'u1' } } };
      },
      onRequest: (config) =>
        refreshed ? respond(config, 200, { ok: true }) : respond(config, 401),
    });

    const results = await Promise.allSettled([
      api.get('/tracking'),
      api.get('/stats/me'),
      api.get('/notifications'),
    ]);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('does not refresh when the 401 came from signing in', async () => {
    const { api, refreshSpy } = await loadApi({
      refresh: async () => ({ data: { access_token: 'fresh', user: {} } }),
      onRequest: (config) =>
        respond(config, 401, { message: 'Invalid email or password' }),
    });

    // A wrong password must reach the form as an error. Refreshing here would
    // swallow it and bounce the user to /login instead.
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('retries a request only once, even if the retry also gets a 401', async () => {
    let calls = 0;
    const { api, refreshSpy } = await loadApi({
      refresh: async () => ({ data: { access_token: 'fresh', user: { id: 'u1' } } }),
      onRequest: (config) => {
        calls += 1;
        return respond(config, 401);
      },
    });

    await expect(api.get('/tracking')).rejects.toBeDefined();
    // Original attempt plus exactly one retry; no loop.
    expect(calls).toBe(2);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the session and stops refreshing once rotation fails', async () => {
    const { api, refreshSpy, useAuthStore } = await loadApi({
      refresh: async () => {
        throw Object.assign(new Error('refresh rejected'), {
          isAxiosError: true,
          response: { status: 401, data: {} },
        });
      },
      onRequest: (config) => respond(config, 401),
    });

    await expect(api.get('/tracking')).rejects.toBeDefined();
    expect(useAuthStore.getState().status).toBe('anonymous');

    // A later 401 must not fan out into another rotation attempt.
    await expect(api.get('/stats/me')).rejects.toBeDefined();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
