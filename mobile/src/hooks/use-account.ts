import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  changeAccountPassword,
  listAccountSessions,
  logoutAllAccountSessions,
  revokeAccountSession,
  updateAccountProfile,
  type ProfileDraft,
} from '@/lib/account';
import { useAuthStore } from '@/store/auth';

export const accountKeys = {
  all: ['account'] as const,
  sessions: ['account', 'sessions'] as const,
};

export function useAccountSessions(enabled = true) {
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: listAccountSessions,
    enabled,
  });
}

export function useUpdateAccountProfile() {
  const setUser = useAuthStore((state) => state.setUser);
  return useMutation({
    mutationFn: (draft: ProfileDraft) => updateAccountProfile(draft),
    onSuccess: (user) => setUser(user),
  });
}

export function useChangeAccountPassword() {
  return useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
    }: {
      currentPassword: string;
      newPassword: string;
    }) => changeAccountPassword(currentPassword, newPassword),
  });
}

export function useRevokeAccountSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAccountSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}

export function useLogoutAllAccountSessions() {
  return useMutation({ mutationFn: logoutAllAccountSessions });
}
