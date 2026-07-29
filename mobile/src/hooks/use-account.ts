import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  changeAccountPassword,
  disableTwoFactor,
  enableTwoFactor,
  listAccountSessions,
  listSecurityActivity,
  logoutAllAccountSessions,
  requestAccountEmailChange,
  resendEmailVerification,
  revokeAccountSession,
  setupTwoFactor,
  updateAccountProfile,
  type ProfileDraft,
} from '@/lib/account';
import {
  deleteAvatar,
  pickAndPrepareAvatar,
  uploadAvatar,
} from '@/lib/avatar';
import { useAuthStore } from '@/store/auth';

export const accountKeys = {
  all: ['account'] as const,
  sessions: ['account', 'sessions'] as const,
  securityActivity: ['account', 'security-activity'] as const,
};

export function useAccountSessions(enabled = true) {
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: listAccountSessions,
    enabled,
  });
}

export function useSecurityActivity(enabled = true) {
  return useQuery({
    queryKey: accountKeys.securityActivity,
    queryFn: listSecurityActivity,
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

export function useUploadAccountAvatar() {
  const setUser = useAuthStore((state) => state.setUser);
  return useMutation({
    mutationFn: async () => {
      const file = await pickAndPrepareAvatar();
      return file ? uploadAvatar(file) : null;
    },
    onSuccess: (result) => {
      const user = useAuthStore.getState().user;
      if (user && result) setUser({ ...user, avatar_url: result.avatar_url });
    },
  });
}

export function useDeleteAccountAvatar() {
  const setUser = useAuthStore((state) => state.setUser);
  return useMutation({
    mutationFn: deleteAvatar,
    onSuccess: () => {
      const user = useAuthStore.getState().user;
      if (user) setUser({ ...user, avatar_url: null });
    },
  });
}

export function useRequestAccountEmailChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      currentPassword,
      newEmail,
      totpCode,
    }: {
      currentPassword: string;
      newEmail: string;
      totpCode?: string;
    }) => requestAccountEmailChange(currentPassword, newEmail, totpCode),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: accountKeys.securityActivity }),
  });
}

export function useChangeAccountPassword() {
  return useMutation({
    mutationFn: ({
      currentPassword,
      newPassword,
      totpCode,
    }: {
      currentPassword: string;
      newPassword: string;
      totpCode?: string;
    }) => changeAccountPassword(currentPassword, newPassword, totpCode),
  });
}

export function useRevokeAccountSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeAccountSession,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
        queryClient.invalidateQueries({ queryKey: accountKeys.securityActivity }),
      ]);
    },
  });
}

export function useLogoutAllAccountSessions() {
  return useMutation({ mutationFn: logoutAllAccountSessions });
}

export function useResendEmailVerification() {
  return useMutation({ mutationFn: resendEmailVerification });
}

export function useSetupTwoFactor() {
  return useMutation({ mutationFn: setupTwoFactor });
}

export function useEnableTwoFactor() {
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: enableTwoFactor,
    onSuccess: () => {
      if (user) setUser({ ...user, two_factor_enabled: true });
      void queryClient.invalidateQueries({ queryKey: accountKeys.securityActivity });
    },
  });
}

export function useDisableTwoFactor() {
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ password, totpCode }: { password: string; totpCode: string }) =>
      disableTwoFactor(password, totpCode),
    onSuccess: () => {
      if (user) setUser({ ...user, two_factor_enabled: false });
      void queryClient.invalidateQueries({ queryKey: accountKeys.securityActivity });
    },
  });
}
