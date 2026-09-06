import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import api, {
  bootstrapSession,
  clearLogoutPending,
  endSession,
  isLogoutPending,
  refreshAccessToken,
  SessionSupersededError,
} from '@/lib/api';
import { useAuthStore } from '@/store/auth';

// Findings M04-M07 of the September audit, all in the same mechanism: a
// rotation is asynchronous, and the session it belongs to can change while it
// is in flight.
const { instance } = vi.hoisted(() => ({
  instance: {
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    post: vi.fn(),
  },
}));

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    default: {
      ...actual.default,
      create: () => instance,
      post: vi.fn(),
      isAxiosError: actual.default.isAxiosError,
    },
    isAxiosError: actual.default.isAxiosError,
  };
});

const mockedPost = vi.mocked(axios.post);

function rejection(status: number) {
  const error = new Error(`HTTP ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number };
  };
  error.isAxiosError = true;
  error.response = { status };
  return error;
}

function transportFailure() {
  const error = new Error('Network timeout') as Error & { isAxiosError: boolean };
  error.isAxiosError = true;
  return error;
}

const user = { id: 'user-1', username: 'owner' } as never;

describe('web session lifecycle', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    vi.mocked(api.post).mockReset();
    clearLogoutPending();
    useAuthStore.setState({ token: null, user: null, status: 'loading', generation: 0 });
  });

  afterEach(() => {
    clearLogoutPending();
  });

  it('discards a rotation that finished after the person signed out', async () => {
    // M05. The old code applied the response unconditionally, so the store went
    // from anonymous back to the previous user because the response arrived
    // last.
    useAuthStore.getState().setAuth('old-token', user);
    let resolve!: (value: unknown) => void;
    mockedPost.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);

    const pending = refreshAccessToken();
    useAuthStore.getState().logout();
    resolve({ data: { access_token: 'late-token', user } });

    await expect(pending).rejects.toBeInstanceOf(SessionSupersededError);
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('does not sign the person out when the network fails', async () => {
    // M06. A timeout is not a verdict on the credential, and treating it as one
    // logged people out of working accounts for the length of a restart.
    mockedPost.mockRejectedValueOnce(transportFailure());
    await bootstrapSession();
    expect(useAuthStore.getState().status).toBe('anonymous');

    // The circuit must stay open: a second attempt still reaches the network.
    mockedPost.mockResolvedValueOnce({ data: { access_token: 'fresh', user } } as never);
    await expect(refreshAccessToken()).resolves.toBe('fresh');
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('stops trying once the server has actually refused the credential', async () => {
    mockedPost.mockRejectedValueOnce(rejection(401));
    await bootstrapSession();
    expect(useAuthStore.getState().status).toBe('anonymous');

    const callsAfterRefusal = mockedPost.mock.calls.length;
    await expect(refreshAccessToken()).rejects.toThrow();
    expect(mockedPost.mock.calls.length).toBe(callsAfterRefusal);
  });

  it('records the intent to sign out before the request, not after it', async () => {
    // Without this the marker is never written when the request fails, and the
    // rest of the mechanism has nothing to act on.
    const post = vi.mocked(api.post);
    post.mockRejectedValueOnce(transportFailure());

    await endSession();

    expect(post).toHaveBeenCalledWith('/auth/logout');
    expect(isLogoutPending()).toBe(true);
  });

  it('clears the intent once the server confirms', async () => {
    const post = vi.mocked(api.post);
    post.mockResolvedValueOnce({ data: {} } as never);

    await endSession();

    expect(isLogoutPending()).toBe(false);
  });

  it('treats a refusal as the session already being gone', async () => {
    const post = vi.mocked(api.post);
    post.mockRejectedValueOnce(rejection(401));

    await endSession();

    expect(isLogoutPending()).toBe(false);
  });

  it('holds a logout the server never heard about, and finishes it on the next load', async () => {
    // M07. The refresh cookie is HttpOnly, so a failed logout left a usable
    // credential behind an interface that said anonymous.
    const { markLogoutPending } = await import('@/lib/api');
    markLogoutPending();
    expect(isLogoutPending()).toBe(true);

    mockedPost.mockResolvedValueOnce({ data: {} } as never);
    await bootstrapSession();

    expect(mockedPost).toHaveBeenCalledWith(
      expect.stringContaining('/auth/logout'),
      undefined,
      expect.anything(),
    );
    expect(isLogoutPending()).toBe(false);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('keeps the logout pending when the retry also fails', async () => {
    const { markLogoutPending } = await import('@/lib/api');
    markLogoutPending();
    mockedPost.mockRejectedValueOnce(transportFailure());

    await bootstrapSession();

    expect(isLogoutPending()).toBe(true);
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('never hydrates a session while a logout is pending', async () => {
    const { markLogoutPending } = await import('@/lib/api');
    markLogoutPending();
    mockedPost.mockRejectedValueOnce(transportFailure());

    await bootstrapSession();

    // The one call is the logout retry, never a refresh.
    const refreshCalls = mockedPost.mock.calls.filter(([url]) =>
      String(url).includes('/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(0);
  });

  it('serialises rotation so two tabs cannot replay one cookie', async () => {
    // M04. Single-flight was a module variable, so each tab had its own. The
    // second tab presented a token the first had consumed, and the server read
    // that as theft and destroyed every session on the account.
    useAuthStore.getState().setAuth('old-token', user);
    mockedPost.mockResolvedValue({ data: { access_token: 'rotated', user } } as never);

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

    expect(a).toBe('rotated');
    expect(b).toBe('rotated');
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });
});
