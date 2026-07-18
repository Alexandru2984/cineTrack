import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  useChangePassword,
  useLogout,
  useSessions,
  useRevokeSession,
  useLogoutAllSessions,
  useDeleteAccount,
  useMe,
  useUploadAvatar,
  useDeleteAvatar,
  useUpdatePrivacy,
  useSetupTwoFactor,
  useEnableTwoFactor,
  useDisableTwoFactor,
} from '@/hooks/useAuth';
import { QRCodeSVG } from 'qrcode.react';
import { useImportJobs, useStartImport, useImportJob } from '@/hooks/useImport';
import {
  useAcceptFollowRequest,
  useFollowRequests,
  useRejectFollowRequest,
} from '@/hooks/useSocial';
import { getApiErrorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import type { ImportJob } from '@/types';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  DownloadCloud,
  ImageUp,
  Info,
  LockKeyhole,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserCircle2,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { InstallAppCard } from '@/components/InstallAppCard';
import { useAuthStore } from '@/store/auth';

function SignOutCard() {
  const navigate = useNavigate();
  const logout = useLogout();

  return (
    <button
      type="button"
      disabled={logout.isPending}
      onClick={() => logout.mutate(undefined, { onSuccess: () => navigate('/login') })}
      className="flex h-12 w-full items-center justify-between border-y border-[hsl(var(--border))] px-1 text-sm font-medium text-[hsl(var(--destructive))] disabled:opacity-50"
    >
      <span className="flex items-center gap-2">
        <LogOut className="h-5 w-5" aria-hidden="true" />
        Sign out
      </span>
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function PrivacyCard() {
  const { data: me } = useMe();
  const updatePrivacy = useUpdatePrivacy();
  const isPrivate = me ? !me.is_public : false;

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <LockKeyhole className="h-5 w-5 text-[hsl(var(--primary))]" /> Profile privacy
          </h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {isPrivate
              ? 'Only approved followers can see your profile details and activity.'
              : 'Your profile details and activity are visible to everyone.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPrivate}
          aria-label="Private profile"
          disabled={!me || updatePrivacy.isPending}
          onClick={() => updatePrivacy.mutate(isPrivate)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            isPrivate ? 'bg-[hsl(var(--primary))]' : 'bg-[hsl(var(--muted))]'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
              isPrivate ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      {updatePrivacy.error && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(updatePrivacy.error, 'Could not update profile privacy')}
        </p>
      )}
    </section>
  );
}

function FollowRequestsCard() {
  const { data: requests, isLoading } = useFollowRequests();
  const accept = useAcceptFollowRequest();
  const reject = useRejectFollowRequest();

  return (
    <section
      id="follow-requests"
      tabIndex={-1}
      className="scroll-mt-24 rounded-lg border border-[hsl(var(--border))] p-6 focus:outline-none"
    >
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <UserRoundCheck className="h-5 w-5 text-[hsl(var(--primary))]" /> Follow requests
      </h2>
      {isLoading ? (
        <Loader2 className="mt-4 h-5 w-5 animate-spin text-[hsl(var(--muted-foreground))]" />
      ) : !requests?.length ? (
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">No pending requests.</p>
      ) : (
        <div className="mt-3 divide-y divide-[hsl(var(--border))]">
          {requests.map((request) => (
            <div key={request.user_id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              {request.avatar_url ? (
                <img
                  src={request.avatar_url}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <UserCircle2 className="h-10 w-10 text-[hsl(var(--muted-foreground))]" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {request.username}
              </span>
              <button
                type="button"
                title="Accept request"
                aria-label={`Accept follow request from ${request.username}`}
                disabled={accept.isPending || reject.isPending}
                onClick={() => accept.mutate(request.user_id)}
                className="rounded-md bg-[hsl(var(--primary))] p-2 text-white disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Reject request"
                aria-label={`Reject follow request from ${request.username}`}
                disabled={accept.isPending || reject.isPending}
                onClick={() => reject.mutate(request.user_id)}
                className="rounded-md border border-[hsl(var(--border))] p-2 hover:text-[hsl(var(--destructive))] disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {(accept.error || reject.error) && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(accept.error ?? reject.error, 'Could not update follow request')}
        </p>
      )}
    </section>
  );
}

function ProfilePictureCard() {
  const { data: me } = useMe();
  const upload = useUploadAvatar();
  const remove = useDeleteAvatar();
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarUrl = me?.avatar_url ?? null;

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) upload.mutate(file);
    e.target.value = '';
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <UserCircle2 className="h-5 w-5 text-[hsl(var(--primary))]" /> Profile picture
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Shown on your profile and next to your activity. PNG, JPEG, WebP or GIF, up to 3 MB.
      </p>

      <div className="mt-4 flex items-center gap-5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt="Your avatar"
            className="h-20 w-20 rounded-full object-cover border border-[hsl(var(--border))]"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--accent))]/40 text-[hsl(var(--muted-foreground))]">
            <UserCircle2 className="h-10 w-10" />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={onPick}
            className="hidden"
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            className="flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
            {avatarUrl ? 'Change picture' : 'Upload picture'}
          </button>
          {avatarUrl && (
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))] disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" /> Remove
            </button>
          )}
        </div>
      </div>
      {upload.error && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(upload.error, 'Could not upload image')}
        </p>
      )}
    </section>
  );
}

function ImportSummary({ job }: { job: ImportJob }) {
  if (job.status === 'failed') {
    return (
      <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
        Import failed: {job.error ?? 'unknown error'}. You can try again below.
      </p>
    );
  }
  if (job.status === 'pending' || job.status === 'running') {
    const t = job.totals;
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
        <Loader2 className="h-4 w-4 animate-spin" />
        Importing…{' '}
        {t && (
          <span>
            {t.shows} shows · {t.movies} movies · {t.episodes_linked} episodes so far
          </span>
        )}
      </div>
    );
  }
  // completed
  const t = job.totals;
  return (
    <div className="mt-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))]/40 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-green-600">
        <CheckCircle2 className="h-4 w-4" /> Import complete
      </p>
      {t && (
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-[hsl(var(--muted-foreground))] sm:grid-cols-3">
          <li>{t.shows} shows</li>
          <li>{t.movies} movies</li>
          <li>{t.episodes_linked} episodes</li>
          {t.rewatches > 0 && <li>{t.rewatches} rewatches</li>}
          {t.episodes_date_only > 0 && <li>{t.episodes_date_only} date-only</li>}
          {t.unresolved.length > 0 && <li>{t.unresolved.length} unresolved</li>}
        </ul>
      )}
      {t && t.unresolved.length > 0 && (
        <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
          Couldn't match: {t.unresolved.slice(0, 8).join(', ')}
          {t.unresolved.length > 8 ? '…' : ''}
        </p>
      )}
    </div>
  );
}

function ImportCard() {
  const { data: jobs } = useImportJobs();
  const startImport = useStartImport();
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const [shows, setShows] = useState<File | null>(null);
  const [movies, setMovies] = useState<File | null>(null);
  const [rewatches, setRewatches] = useState<File | null>(null);

  const existing = jobs?.[0] ?? null;
  const activeJobId = startedJobId ?? (existing && existing.status !== 'failed' ? existing.id : null);
  const { data: polledJob } = useImportJob(activeJobId);
  const job = polledJob ?? existing;
  const showForm = !job || job.status === 'failed';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startImport.mutate(
      { shows, movies, rewatches },
      { onSuccess: (data) => setStartedJobId(data.job_id) }
    );
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <DownloadCloud className="h-5 w-5 text-[hsl(var(--primary))]" /> Import from TV Time
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Moving from TV Time? Upload your export and we'll bring over your shows, movies,
        episode history and ratings. Get your data from the TV Time app under Settings →
        Export, or the browser extension (produces <code>shows.json</code> and{' '}
        <code>movies.json</code>).
      </p>

      {job && <ImportSummary job={job} />}

      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-md">
          <div>
            <label htmlFor="import-shows" className="block text-sm font-medium mb-1">
              shows.json <span className="text-[hsl(var(--muted-foreground))]">(required)</span>
            </label>
            <input
              id="import-shows"
              type="file"
              accept=".json,application/json"
              onChange={(e) => setShows(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[hsl(var(--primary))] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:opacity-90"
            />
          </div>
          <div>
            <label htmlFor="import-movies" className="block text-sm font-medium mb-1">
              movies.json <span className="text-[hsl(var(--muted-foreground))]">(optional)</span>
            </label>
            <input
              id="import-movies"
              type="file"
              accept=".json,application/json"
              onChange={(e) => setMovies(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[hsl(var(--secondary))] file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:opacity-90"
            />
          </div>
          <div>
            <label htmlFor="import-rewatches" className="block text-sm font-medium mb-1">
              rewatched_episode.csv{' '}
              <span className="text-[hsl(var(--muted-foreground))]">(optional, from GDPR export)</span>
            </label>
            <input
              id="import-rewatches"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setRewatches(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[hsl(var(--secondary))] file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:opacity-90"
            />
          </div>

          {startImport.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(startImport.error, 'Could not start import')}
            </p>
          )}
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            The import runs in the background and can take a couple of minutes. You can leave this page.
          </p>

          <button
            type="submit"
            disabled={startImport.isPending || !shows}
            className="flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {startImport.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            Start import
          </button>
        </form>
      )}
    </section>
  );
}

function ChangePasswordCard() {
  const navigate = useNavigate();
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
          navigate('/login');
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
        Updating your password signs out every device, including this one.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-sm">
        <div>
          <label htmlFor="change-current-password" className="block text-sm font-medium mb-1">Current password</label>
          <input
            id="change-current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
        </div>
        <div>
          <label htmlFor="change-new-password" className="block text-sm font-medium mb-1">New password</label>
          <input
            id="change-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            placeholder="Min 8 characters"
          />
        </div>
        <div>
          <label htmlFor="change-confirm-password" className="block text-sm font-medium mb-1">Confirm new password</label>
          <input
            id="change-confirm-password"
            type="password"
            autoComplete="new-password"
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

function TwoFactorCard() {
  const user = useAuthStore((state) => state.user);
  const enabled = user?.two_factor_enabled ?? false;
  const setup = useSetupTwoFactor();
  const enable = useEnableTwoFactor();
  const disable = useDisableTwoFactor();
  const [code, setCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const startSetup = (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryCodes(null);
    setCode('');
    setup.mutate(setupPassword, { onSuccess: () => setSetupPassword('') });
  };

  const cancelSetup = () => {
    setup.reset();
    enable.reset();
    setCode('');
  };

  const confirmEnable = (e: React.FormEvent) => {
    e.preventDefault();
    enable.mutate(code.trim(), {
      onSuccess: (data) => {
        setRecoveryCodes(data.recovery_codes);
        setup.reset();
        setCode('');
      },
    });
  };

  const confirmDisable = (e: React.FormEvent) => {
    e.preventDefault();
    disable.mutate(password, { onSuccess: () => setPassword('') });
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <ShieldCheck className="h-5 w-5 text-[hsl(var(--primary))]" /> Two-factor authentication
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        Require a time-based code from an authenticator app when you sign in.
      </p>

      {/* One-time recovery codes shown right after activation. */}
      {recoveryCodes ? (
        <div className="mt-4 max-w-md space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />
            Save these recovery codes somewhere safe. Each works once if you lose your
            authenticator. They won't be shown again.
          </div>
          <ul className="grid grid-cols-2 gap-2 rounded-md border border-[hsl(var(--border))] p-3 font-mono text-sm">
            {recoveryCodes.map((rc) => (
              <li key={rc}>{rc}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setRecoveryCodes(null)}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            I've saved my codes
          </button>
        </div>
      ) : enabled ? (
        <form onSubmit={confirmDisable} className="mt-4 max-w-sm space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--primary))]">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Two-factor is on.
          </p>
          <label htmlFor="twofa-disable-password" className="block text-sm font-medium">
            Confirm your password to turn it off
          </label>
          <input
            id="twofa-disable-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
          {disable.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(disable.error, 'Could not disable two-factor')}
            </p>
          )}
          <button
            type="submit"
            disabled={disable.isPending}
            className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))] hover:text-white disabled:opacity-50"
          >
            {disable.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Disable two-factor
          </button>
        </form>
      ) : setup.data ? (
        <form onSubmit={confirmEnable} className="mt-4 space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="rounded-md border border-[hsl(var(--border))] bg-white p-3">
              <QRCodeSVG value={setup.data.otpauth_uri} size={168} marginSize={0} />
            </div>
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <p>Scan this with your authenticator app, or enter the key manually:</p>
              <code className="block break-all rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2 py-1.5 font-mono text-xs">
                {setup.data.secret}
              </code>
              <label htmlFor="twofa-enable-code" className="block pt-1 font-medium">
                Enter the 6-digit code to confirm
              </label>
              <input
                id="twofa-enable-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                className="w-full max-w-[12rem] rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
                placeholder="123456"
              />
            </div>
          </div>
          {enable.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(enable.error, 'Could not enable two-factor')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={enable.isPending}
              className="flex items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {enable.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm &amp; enable
            </button>
            <button
              type="button"
              onClick={cancelSetup}
              className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={startSetup} className="mt-4 max-w-sm space-y-3">
          <label htmlFor="twofa-setup-password" className="block text-sm font-medium">
            Confirm your password to set up two-factor
          </label>
          <input
            id="twofa-setup-password"
            type="password"
            autoComplete="current-password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            required
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
          />
          {setup.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(setup.error, 'Could not start two-factor setup')}
            </p>
          )}
          <button
            type="submit"
            disabled={setup.isPending}
            className="flex items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Enable two-factor
          </button>
        </form>
      )}
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
  const logout = useAuthStore((state) => state.logout);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const deleteAccount = useDeleteAccount();

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await deleteAccount.mutateAsync({ password });
      logout();
      window.location.replace('/login');
    } catch {
      // The mutation keeps the sanitized API error for the inline message.
    }
  };

  return (
    <section
      id="delete-account"
      tabIndex={-1}
      className="scroll-mt-20 rounded-lg border border-[hsl(var(--destructive))] p-6 focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
    >
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
            <label htmlFor="delete-account-password" className="block text-sm font-medium mb-1">
              Enter your password to confirm
            </label>
            <input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
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
  const location = useLocation();

  useEffect(() => {
    const targetId =
      location.hash === '#follow-requests'
        ? 'follow-requests'
        : location.hash === '#delete-account'
          ? 'delete-account'
          : null;
    if (!targetId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <ProfilePictureCard />
      <PrivacyCard />
      <InstallAppCard />
      <FollowRequestsCard />
      <ImportCard />
      <ChangePasswordCard />
      <TwoFactorCard />
      <SessionsCard />
      <SignOutCard />
      <Link
        to="/about"
        className="flex items-center justify-between gap-4 border-y border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <Info className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          About &amp; data sources
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <Link
        to="/privacy"
        className="flex items-center justify-between gap-4 border-b border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          Privacy policy
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <DangerZoneCard />
    </div>
  );
}
