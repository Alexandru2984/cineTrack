import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchPeerKeys,
  loadStoredIdentity,
  restoreIdentity,
  setupIdentity,
} from '@/lib/crypto/session';
import { storageIsAvailable } from '@/lib/crypto/storage';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useEncryptionStore } from '@/store/encryption';
import type { KeyStatus, PeerPublicKeys } from '@/types';

export const encryptionKeys = {
  status: ['encryption', 'status'] as const,
  peer: (username: string) => ['encryption', 'peer', username.toLowerCase()] as const,
};

export function useKeyStatus() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated());
  return useQuery<KeyStatus>({
    queryKey: encryptionKeys.status,
    queryFn: async () => {
      const response = await api.get<KeyStatus>('/encryption/keys');
      return response.data;
    },
    enabled: isAuthenticated,
    // Keys change when the user sets them up or replaces them, both of which
    // invalidate this explicitly. Polling for them would be noise.
    staleTime: Infinity,
  });
}

/** A peer's published keys, or null when they have none.
 *
 *  Null is a normal answer during rollout and means the conversation stays in
 *  plain text — so it is cached like any other answer rather than retried. */
export function usePeerKeys(username: string, enabled = true) {
  return useQuery<PeerPublicKeys | null>({
    queryKey: encryptionKeys.peer(username),
    queryFn: () => fetchPeerKeys(username),
    enabled: enabled && Boolean(username),
    staleTime: 5 * 60 * 1000,
  });
}

/** Load this device's keys once per session and keep the store's status honest.
 *
 *  Mounted high in the tree. The three outcomes it distinguishes — no keys
 *  anywhere, keys elsewhere but not here, keys here — are what every messaging
 *  screen branches on, and working them out per screen would give different
 *  answers in different places. */
export function useEncryptionSession() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated());
  const setIdentity = useEncryptionStore((state) => state.setIdentity);
  const setStatus = useEncryptionStore((state) => state.setStatus);
  const clear = useEncryptionStore((state) => state.clear);
  const { data: status } = useKeyStatus();

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      setStatus('loading');
      return;
    }
    if (!status) return;

    let cancelled = false;
    void (async () => {
      if (!(await storageIsAvailable())) {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      const stored = await loadStoredIdentity(userId);
      if (cancelled) return;
      if (stored && (!status.key_fingerprint || status.key_fingerprint === stored.fingerprint)) {
        setIdentity(stored.identity, stored.fingerprint);
        return;
      }
      // Keys stored here that the directory no longer lists are keys replaced
      // on another device. Treating that as "locked" rather than "ready" is the
      // difference between prompting for a restore and silently sending
      // messages nobody can read.
      setStatus(status.has_keys ? 'locked' : 'absent');
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, userId, status, setIdentity, setStatus]);

  useEffect(() => {
    if (isAuthenticated) return;
    void clear(null);
  }, [isAuthenticated, clear]);
}

export function useSetupEncryption() {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const setIdentity = useEncryptionStore((state) => state.setIdentity);

  return useMutation({
    mutationFn: async (password: string) => {
      if (!userId) throw new Error('not-authenticated');
      return setupIdentity(userId, password);
    },
    onSuccess: (result) => {
      setIdentity(result.identity, result.fingerprint);
      void queryClient.invalidateQueries({ queryKey: encryptionKeys.status });
    },
  });
}

export function useRestoreEncryption() {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const setIdentity = useEncryptionStore((state) => state.setIdentity);

  return useMutation({
    mutationFn: async ({
      secret,
      kind,
    }: {
      secret: string;
      kind: 'password' | 'recovery';
    }) => {
      if (!userId) throw new Error('not-authenticated');
      return restoreIdentity(userId, secret, kind);
    },
    onSuccess: (result) => {
      setIdentity(result.identity, result.fingerprint);
      void queryClient.invalidateQueries({ queryKey: encryptionKeys.status });
    },
  });
}
