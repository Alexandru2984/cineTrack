import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useChangePassword,
  useSessions,
  useRevokeSession,
  useLogoutAllSessions,
  useDeleteAccount,
} from '@/hooks/useAuth';
import { getApiErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { AlertTriangle, KeyRound, Loader2, LogOut, Monitor, Trash2 } from 'lucide-react';

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const changePassword = useChangePassword();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    changePassword.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
        },
      }
    );
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="h-5 w-5 text-[hsl(var(--primary))]" /> Change password
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Updating your password signs out every other device.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-sm">
        <div>
          <label className="block text-sm font-medium mb-1">Current password</label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">New password</label>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            placeholder="Min 8 characters"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm new password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>

        {mismatch && (
          <p className="text-sm text-[hsl(var(--destructive))]">New passwords do not match</p>
        )}
        {changePassword.error && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {getApiErrorMessage(changePassword.error, 'Could not change password')}
          </p>
        )}
        {changePassword.isSuccess && (
          <p className="text-sm text-green-600">Password changed successfully.</p>
        )}

        <button
          type="submit"
          disabled={changePassword.isPending}
          className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {changePassword.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Update password
        </button>
      </form>
    </section>
  );
}

function SessionsCard() {
  const navigate = useNavigate();
  const { data: sessions, isLoading, isError } = useSessions();
  const revoke = useRevokeSession();
  const logoutAll = useLogoutAllSessions();

  const handleLogoutAll = () => {
    logoutAll.mutate(undefined, { onSuccess: () => navigate('/login') });
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Monitor className="h-5 w-5 text-[hsl(var(--primary))]" /> Active sessions
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Devices currently signed in to your account.
      </p>

      <div className="mt-4 space-y-3">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading sessions…
          </p>
        )}
        {isError && (
          <p className="text-sm text-[hsl(var(--destructive))]">Could not load sessions.</p>
        )}
        {sessions?.length === 0 && (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">No active sessions.</p>
        )}

        {sessions?.map((session) => (
          <div
            key={session.id}
            className="flex items-center justify-between gap-4 rounded-md border border-[hsl(var(--border))] px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {session.user_agent || 'Unknown device'}
                {session.current && (
                  <span className="ml-2 rounded-full bg-[hsl(var(--primary))] px-2 py-0.5 text-xs text-white">
                    This device
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                {session.ip_address || 'Unknown IP'} · last active{' '}
                {formatDateTime(session.last_used_at)}
              </p>
            </div>
            {!session.current && (
              <button
                onClick={() => revoke.mutate(session.id)}
                disabled={revoke.isPending}
                className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                title="Revoke this session"
              >
                <Trash2 className="h-3.5 w-3.5" /> Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleLogoutAll}
        disabled={logoutAll.isPending}
        className="mt-4 flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))] disabled:opacity-50"
      >
        {logoutAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        Sign out of all devices
      </button>
    </section>
  );
}

function DangerZoneCard() {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const deleteAccount = useDeleteAccount();

  const handleDelete = (e: React.FormEvent) => {
    e.preventDefault();
    deleteAccount.mutate({ password }, { onSuccess: () => navigate('/login') });
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--destructive))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-[hsl(var(--destructive))]">
        <AlertTriangle className="h-5 w-5" /> Delete account
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Permanently deletes your account and all of your data. This cannot be undone.
      </p>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="mt-4 flex items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <Trash2 className="h-4 w-4" /> Delete my account
        </button>
      ) : (
        <form onSubmit={handleDelete} className="mt-4 space-y-4 max-w-sm">
          <div>
            <label className="block text-sm font-medium mb-1">
              Enter your password to confirm
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            />
          </div>

          {deleteAccount.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(deleteAccount.error, 'Could not delete account')}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={deleteAccount.isPending}
              className="flex items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {deleteAccount.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Permanently delete
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setPassword('');
              }}
              className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <ChangePasswordCard />
      <SessionsCard />
      <DangerZoneCard />
    </div>
  );
}
