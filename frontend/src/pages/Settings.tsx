import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  useChangePassword,
  useChangeEmail,
  useLogout,
  useSessions,
  useSecurityActivity,
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
  History,
  LockKeyhole,
  KeyRound,
  Mail,
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
import { CalendarFeedCard } from '@/components/CalendarFeedCard';
import { BlockedUsersCard } from '@/components/BlockedUsersCard';
import { LanguageCard } from '@/components/LanguageCard';
import { Switch } from '@/components/Switch';
import { useAuthStore } from '@/store/auth';
import { EncryptionSettingsCard } from '@/components/EncryptionSettingsCard';
import { useT } from '@/hooks/useT';
import { useModeratorStatus } from '@/hooks/useCommunitySafety';

function SensitiveActionCodeField({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const t = useT();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">
        {label ?? t('settings.sensitiveActionCode')}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="one-time-code"
        autoCapitalize="none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
        maxLength={64}
        className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
      />
      <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
        {t('settings.sensitiveActionCodeHint')}
      </p>
    </div>
  );
}

function SignOutCard() {
  const t = useT();
  const navigate = useNavigate();
  const logout = useLogout();

  const handleSignOut = async (forgetKeys = false) => {
    await logout.mutateAsync({ forgetKeys });
    navigate('/login', { replace: true });
  };

  return (
    <div className="border-y border-[hsl(var(--border))]">
      <button
        type="button"
        disabled={logout.isPending}
        onClick={() => void handleSignOut(false)}
        className="flex h-12 w-full items-center justify-between px-1 text-sm font-medium text-[hsl(var(--destructive))] disabled:opacity-50"
      >
        <span className="flex items-center gap-2">
          <LogOut className="h-5 w-5" aria-hidden="true" />
          {t('settings.signOut')}
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
      {/* The shared-device answer, offered rather than assumed. Signing out
          keeps the message keys so the next sign-in does not ask for a password
          or a recovery code; on a borrowed browser that hands the next person
          every past message. */}
      <button
        type="button"
        disabled={logout.isPending}
        onClick={() => void handleSignOut(true)}
        className="flex w-full flex-col items-start gap-0.5 border-t border-[hsl(var(--border))] px-1 py-2 text-left text-sm font-medium text-[hsl(var(--destructive))] disabled:opacity-50"
      >
        <span>{t('settings.signOutAndForgetKeys')}</span>
        <span className="text-xs font-normal text-[hsl(var(--muted-foreground))]">
          {t('settings.signOutAndForgetKeysHint')}
        </span>
      </button>
    </div>
  );
}

function ModerationCard() {
  const t = useT();
  const moderator = useModeratorStatus();
  if (!moderator.data?.is_moderator) return null;

  return (
    <Link
      to="/moderation"
      className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 hover:bg-amber-500/10 sm:p-6"
    >
      <span className="flex min-w-0 items-start gap-3">
        <ShieldCheck
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <span>
          <span className="block font-semibold">{t('moderation.settingsTitle')}</span>
          <span className="mt-1 block text-sm text-[hsl(var(--muted-foreground))]">
            {t('moderation.settingsHint')}
          </span>
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0" aria-hidden="true" />
    </Link>
  );
}

function PrivacyCard() {
  const t = useT();
  const { data: me } = useMe();
  const updatePrivacy = useUpdatePrivacy();
  const isPrivate = me ? !me.is_public : false;
  const needsVerification = Boolean(me && !me.email_verified && isPrivate);

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <LockKeyhole className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.privacyTitle')}
          </h2>
          <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
            {isPrivate
              ? needsVerification
                ? t('settings.privacyVerifyHint')
                : t('settings.privacyPrivate')
              : t('settings.privacyPublic')}
          </p>
        </div>
        <Switch
          checked={isPrivate}
          label={t('settings.privateProfileAria')}
          disabled={!me || updatePrivacy.isPending || needsVerification}
          onCheckedChange={(privateProfile) => updatePrivacy.mutate(!privateProfile)}
        />
      </div>
      {updatePrivacy.error && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(updatePrivacy.error, t('settings.privacyError'))}
        </p>
      )}
    </section>
  );
}

function FollowRequestsCard() {
  const t = useT();
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
        <UserRoundCheck className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.followRequests')}
      </h2>
      {isLoading ? (
        <Loader2 className="mt-4 h-5 w-5 animate-spin text-[hsl(var(--muted-foreground))]" />
      ) : !requests?.length ? (
        <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">{t('settings.noPendingRequests')}</p>
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
                title={t('settings.acceptRequest')}
                aria-label={t('settings.acceptRequestFrom', { username: request.username })}
                disabled={accept.isPending || reject.isPending}
                onClick={() => accept.mutate(request.user_id)}
                className="rounded-md bg-[hsl(var(--primary))] p-2 text-[hsl(var(--primary-foreground))] disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                title={t('settings.rejectRequest')}
                aria-label={t('settings.rejectRequestFrom', { username: request.username })}
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
          {getApiErrorMessage(accept.error ?? reject.error, t('settings.followRequestError'))}
        </p>
      )}
    </section>
  );
}

function ProfilePictureCard() {
  const t = useT();
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
        <UserCircle2 className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.profilePicture')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.profilePictureHint')}
      </p>

      <div className="mt-4 flex items-center gap-5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={t('settings.avatarAlt')}
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
            className="flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}
            {avatarUrl ? t('settings.changePicture') : t('settings.uploadPicture')}
          </button>
          {avatarUrl && (
            <button
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))] disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" /> {t('settings.remove')}
            </button>
          )}
        </div>
      </div>
      {upload.error && (
        <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
          {getApiErrorMessage(upload.error, t('settings.uploadError'))}
        </p>
      )}
    </section>
  );
}

function ImportSummary({ job }: { job: ImportJob }) {
  const t = useT();
  if (job.status === 'failed') {
    return (
      <p className="mt-3 text-sm text-[hsl(var(--destructive))]">
        {t('settings.importFailed', { error: job.error ?? t('settings.unknownError') })}
      </p>
    );
  }
  if (job.status === 'pending' || job.status === 'running') {
    const totals = job.totals;
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('settings.importing')}{' '}
        {totals && (
          <span>
            {t('settings.importProgress', {
              shows: totals.shows,
              movies: totals.movies,
              episodes: totals.episodes_linked,
            })}
          </span>
        )}
      </div>
    );
  }
  // completed
  const totals = job.totals;
  return (
    <div className="mt-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))]/40 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-green-600">
        <CheckCircle2 className="h-4 w-4" /> {t('settings.importComplete')}
      </p>
      {totals && (
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-[hsl(var(--muted-foreground))] sm:grid-cols-3">
          <li>{t('settings.countShows', { count: totals.shows })}</li>
          <li>{t('settings.countMovies', { count: totals.movies })}</li>
          <li>{t('settings.countEpisodes', { count: totals.episodes_linked })}</li>
          {totals.rewatches > 0 && <li>{t('settings.countRewatches', { count: totals.rewatches })}</li>}
          {totals.episodes_date_only > 0 && <li>{t('settings.countDateOnly', { count: totals.episodes_date_only })}</li>}
          {totals.unresolved.length > 0 && <li>{t('settings.countUnresolved', { count: totals.unresolved.length })}</li>}
        </ul>
      )}
      {totals && totals.unresolved.length > 0 && (
        <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
          {t('settings.couldntMatch', {
            list: totals.unresolved.slice(0, 8).join(', ') + (totals.unresolved.length > 8 ? '…' : ''),
          })}
        </p>
      )}
    </div>
  );
}

function ImportCard() {
  const t = useT();
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
        <DownloadCloud className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.importTitle')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.importIntroPre')} <code>shows.json</code> {t('settings.andConnector')}{' '}
        <code>movies.json</code>{t('settings.importIntroPost')}
      </p>

      {job && <ImportSummary job={job} />}

      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-md">
          <div>
            <label htmlFor="import-shows" className="block text-sm font-medium mb-1">
              shows.json <span className="text-[hsl(var(--muted-foreground))]">{t('settings.required')}</span>
            </label>
            <input
              id="import-shows"
              type="file"
              accept=".json,application/json"
              onChange={(e) => setShows(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[hsl(var(--primary))] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[hsl(var(--primary-foreground))] hover:file:opacity-90"
            />
          </div>
          <div>
            <label htmlFor="import-movies" className="block text-sm font-medium mb-1">
              movies.json <span className="text-[hsl(var(--muted-foreground))]">{t('settings.optional')}</span>
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
              <span className="text-[hsl(var(--muted-foreground))]">{t('settings.rewatchesOptional')}</span>
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
              {getApiErrorMessage(startImport.error, t('settings.importStartError'))}
            </p>
          )}
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {t('settings.importBackground')}
          </p>

          <button
            type="submit"
            disabled={startImport.isPending || !shows}
            className="flex items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {startImport.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            {t('settings.startImport')}
          </button>
        </form>
      )}
    </section>
  );
}

function ChangeEmailCard() {
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const [password, setPassword] = useState('');
  const [nextEmail, setNextEmail] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const changeEmail = useChangeEmail();
  const sent = changeEmail.isSuccess;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    changeEmail.mutate(
      {
        current_password: password,
        new_email: nextEmail,
        ...(user?.two_factor_enabled ? { totp_code: totpCode.trim() } : {}),
      },
      {
        onSuccess: () => {
          setPassword('');
          setTotpCode('');
        },
      },
    );
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Mail className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.changeEmail')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.changeEmailIntroPre')} <span className="font-medium">{user?.email}</span>{t('settings.changeEmailIntroPost')}
      </p>

      {sent ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-4 text-sm">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--primary))]" />
          <div>
            <p className="font-medium">{t('settings.checkEmail', { email: nextEmail })}</p>
            <p className="text-[hsl(var(--muted-foreground))]">
              {t('settings.changeEmailSentHint', { email: user?.email ?? '' })}
            </p>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-sm">
          <div>
            <label htmlFor="change-email-address" className="block text-sm font-medium mb-1">
              {t('settings.newEmail')}
            </label>
            <input
              id="change-email-address"
              type="email"
              autoComplete="email"
              value={nextEmail}
              onChange={(e) => setNextEmail(e.target.value)}
              required
              maxLength={254}
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            />
          </div>
          <div>
            <label htmlFor="change-email-password" className="block text-sm font-medium mb-1">
              {t('settings.currentPassword')}
            </label>
            <input
              id="change-email-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            />
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
              {t('settings.changeEmailPasswordHint')}
            </p>
          </div>
          {user?.two_factor_enabled && (
            <SensitiveActionCodeField
              id="change-email-totp"
              value={totpCode}
              onChange={setTotpCode}
            />
          )}

          {changeEmail.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(changeEmail.error, t('settings.changeEmailError'))}
            </p>
          )}
          <button
            type="submit"
            disabled={changeEmail.isPending}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {changeEmail.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.sendConfirmationLink')}
          </button>
        </form>
      )}
    </section>
  );
}

function ChangePasswordCard() {
  const t = useT();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpCode, setTotpCode] = useState('');
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
      {
        current_password: current,
        new_password: next,
        ...(user?.two_factor_enabled ? { totp_code: totpCode.trim() } : {}),
      },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          setTotpCode('');
          navigate('/login');
        },
      }
    );
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.changePassword')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.changePasswordHint')}
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4 max-w-sm">
        <div>
          <label htmlFor="change-current-password" className="block text-sm font-medium mb-1">{t('settings.currentPassword')}</label>
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
          <label htmlFor="change-new-password" className="block text-sm font-medium mb-1">{t('settings.newPassword')}</label>
          <input
            id="change-new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
            placeholder={t('auth.passwordMinPlaceholder')}
          />
        </div>
        <div>
          <label htmlFor="change-confirm-password" className="block text-sm font-medium mb-1">{t('settings.confirmNewPassword')}</label>
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
        {user?.two_factor_enabled && (
          <SensitiveActionCodeField
            id="change-password-totp"
            value={totpCode}
            onChange={setTotpCode}
          />
        )}

        {mismatch && (
          <p className="text-sm text-[hsl(var(--destructive))]">{t('settings.passwordsMismatch')}</p>
        )}
        {changePassword.error && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {getApiErrorMessage(changePassword.error, t('settings.changePasswordError'))}
          </p>
        )}
        <button
          type="submit"
          disabled={changePassword.isPending}
          className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {changePassword.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('settings.updatePassword')}
        </button>
      </form>
    </section>
  );
}

function TwoFactorCard() {
  const t = useT();
  const user = useAuthStore((state) => state.user);
  const enabled = user?.two_factor_enabled ?? false;
  const emailVerified = user?.email_verified ?? false;
  const setup = useSetupTwoFactor();
  const enable = useEnableTwoFactor();
  const disable = useDisableTwoFactor();
  const [code, setCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
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
    disable.mutate(
      { password, totp_code: disableCode.trim() },
      {
        onSuccess: () => {
          setPassword('');
          setDisableCode('');
        },
      },
    );
  };

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <ShieldCheck className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.twoFactor')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.twoFactorHint')}
      </p>

      {/* One-time recovery codes shown right after activation. */}
      {recoveryCodes ? (
        <div className="mt-4 max-w-md space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--accent))] p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--primary))]" aria-hidden="true" />
            {t('settings.recoveryCodesWarning')}
          </div>
          <ul className="grid grid-cols-2 gap-2 rounded-md border border-[hsl(var(--border))] p-3 font-mono text-sm">
            {recoveryCodes.map((rc) => (
              <li key={rc}>{rc}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setRecoveryCodes(null)}
            className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90"
          >
            {t('settings.savedCodes')}
          </button>
        </div>
      ) : enabled ? (
        <form onSubmit={confirmDisable} className="mt-4 max-w-sm space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--primary))]">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" /> {t('settings.twoFactorOn')}
          </p>
          <label htmlFor="twofa-disable-password" className="block text-sm font-medium">
            {t('settings.disablePasswordLabel')}
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
          <SensitiveActionCodeField
            id="twofa-disable-code"
            value={disableCode}
            onChange={setDisableCode}
            label={t('settings.disableCodeLabel')}
          />
          {disable.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(disable.error, t('settings.disableError'))}
            </p>
          )}
          <button
            type="submit"
            disabled={disable.isPending}
            className="flex items-center justify-center gap-2 rounded-md border border-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive-foreground))] disabled:opacity-50"
          >
            {disable.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.disableTwoFactor')}
          </button>
        </form>
      ) : setup.data ? (
        <form onSubmit={confirmEnable} className="mt-4 space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="rounded-md border border-[hsl(var(--border))] bg-white p-3">
              <QRCodeSVG value={setup.data.otpauth_uri} size={168} marginSize={0} />
            </div>
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <p>{t('settings.scanInstructions')}</p>
              <code className="block break-all rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2 py-1.5 font-mono text-xs">
                {setup.data.secret}
              </code>
              <label htmlFor="twofa-enable-code" className="block pt-1 font-medium">
                {t('settings.enterCodeToConfirm')}
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
              {getApiErrorMessage(enable.error, t('settings.enableError'))}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={enable.isPending}
              className="flex items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              {enable.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('settings.confirmEnable')}
            </button>
            <button
              type="button"
              onClick={cancelSetup}
              className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={startSetup} className="mt-4 max-w-sm space-y-3">
          <label htmlFor="twofa-setup-password" className="block text-sm font-medium">
            {t('settings.setupPasswordLabel')}
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
              {getApiErrorMessage(setup.error, t('settings.setupError'))}
            </p>
          )}
          {!emailVerified && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {t('settings.verifyEmailFirst')}
            </p>
          )}
          <button
            type="submit"
            disabled={setup.isPending || !emailVerified}
            className="flex items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 disabled:opacity-50"
          >
            {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.enableTwoFactor')}
          </button>
        </form>
      )}
    </section>
  );
}

function SessionsCard() {
  const t = useT();
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
        <Monitor className="h-5 w-5 text-[hsl(var(--primary))]" /> {t('settings.sessions')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.sessionsHint')}
      </p>

      <div className="mt-4 space-y-3">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('settings.loadingSessions')}
          </p>
        )}
        {isError && (
          <p className="text-sm text-[hsl(var(--destructive))]">{t('settings.sessionsError')}</p>
        )}
        {sessions?.length === 0 && (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">{t('settings.noSessions')}</p>
        )}

        {sessions?.map((session) => (
          <div
            key={session.id}
            className="flex items-center justify-between gap-4 rounded-md border border-[hsl(var(--border))] px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {session.user_agent || t('settings.unknownDevice')}
                {session.current && (
                  <span className="ml-2 rounded-full bg-[hsl(var(--primary))] px-2 py-0.5 text-xs text-[hsl(var(--primary-foreground))]">
                    {t('settings.thisDevice')}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                {session.ip_address || t('settings.unknownIp')} ·{' '}
                {t('settings.lastActive', { when: formatDateTime(session.last_used_at) })}
              </p>
            </div>
            {!session.current && (
              <button
                onClick={() => revoke.mutate(session.id)}
                disabled={revoke.isPending}
                className="flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
                title={t('settings.revokeSession')}
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('settings.revoke')}
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
        {t('settings.signOutAll')}
      </button>
    </section>
  );
}

const SECURITY_ACTIVITY_LABEL_KEYS: Record<string, string> = {
  account_registered: 'settings.securityEventAccountRegistered',
  login_succeeded: 'settings.securityEventLoginSucceeded',
  password_changed: 'settings.securityEventPasswordChanged',
  password_reset: 'settings.securityEventPasswordReset',
  email_change_requested: 'settings.securityEventEmailChangeRequested',
  email_changed: 'settings.securityEventEmailChanged',
  two_factor_enabled: 'settings.securityEventTwoFactorEnabled',
  two_factor_disabled: 'settings.securityEventTwoFactorDisabled',
  session_revoked: 'settings.securityEventSessionRevoked',
  all_sessions_revoked: 'settings.securityEventAllSessionsRevoked',
  account_data_exported: 'settings.securityEventAccountDataExported',
};

function SecurityActivityCard() {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const { data: activity, isLoading, isError } = useSecurityActivity();
  const visibleActivity = showAll ? activity : activity?.slice(0, 10);

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <History className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />{' '}
        {t('settings.securityActivity')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.securityActivityHint')}
      </p>
      <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
        {t('settings.securityEmailAlertsHint')}
      </p>

      <div className="mt-4">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 className="h-4 w-4 animate-spin" />{' '}
            {t('settings.loadingSecurityActivity')}
          </p>
        )}
        {isError && (
          <p className="text-sm text-[hsl(var(--destructive))]">
            {t('settings.securityActivityError')}
          </p>
        )}
        {activity?.length === 0 && (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            {t('settings.noSecurityActivity')}
          </p>
        )}

        {visibleActivity && visibleActivity.length > 0 && (
          <ol className="divide-y divide-[hsl(var(--border))] border-y border-[hsl(var(--border))]">
            {visibleActivity.map((event) => (
              <li key={event.id} className="flex min-w-0 items-start gap-3 py-3">
                <span
                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--accent))]"
                  aria-hidden="true"
                >
                  <ShieldCheck className="h-4 w-4 text-[hsl(var(--primary))]" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {t(
                      SECURITY_ACTIVITY_LABEL_KEYS[event.event_type] ??
                        'settings.securityEventUnknown',
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                    {t('settings.securityActivityMeta', {
                      ip: event.ip_address || t('settings.unknownIp'),
                      when: formatDateTime(event.created_at),
                    })}
                  </p>
                  <p
                    className="mt-0.5 truncate text-xs text-[hsl(var(--muted-foreground))]"
                    title={event.user_agent || t('settings.unknownDevice')}
                  >
                    {event.user_agent || t('settings.unknownDevice')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {activity && activity.length > 10 && (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className="mt-4 rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
        >
          {showAll
            ? t('settings.showRecentSecurityActivity')
            : t('settings.showAllSecurityActivity', { count: activity.length })}
        </button>
      )}
    </section>
  );
}

function DangerZoneCard() {
  const t = useT();
  const logout = useAuthStore((state) => state.logout);
  const user = useAuthStore((state) => state.user);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const deleteAccount = useDeleteAccount();

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await deleteAccount.mutateAsync({
        password,
        ...(user?.two_factor_enabled ? { totp_code: totpCode.trim() } : {}),
      });
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
        <AlertTriangle className="h-5 w-5" /> {t('settings.deleteAccount')}
      </h2>
      <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t('settings.deleteAccountHint')}
      </p>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="mt-4 flex items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-[hsl(var(--destructive-foreground))] hover:opacity-90"
        >
          <Trash2 className="h-4 w-4" /> {t('settings.deleteMyAccount')}
        </button>
      ) : (
        <form onSubmit={handleDelete} className="mt-4 space-y-4 max-w-sm">
          <div>
            <label htmlFor="delete-account-password" className="block text-sm font-medium mb-1">
              {t('settings.deletePasswordLabel')}
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
          {user?.two_factor_enabled && (
            <SensitiveActionCodeField
              id="delete-account-totp"
              value={totpCode}
              onChange={setTotpCode}
            />
          )}

          {deleteAccount.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {getApiErrorMessage(deleteAccount.error, t('settings.deleteError'))}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={deleteAccount.isPending}
              className="flex items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-4 py-2 text-sm font-medium text-[hsl(var(--destructive-foreground))] hover:opacity-90 disabled:opacity-50"
            >
              {deleteAccount.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('settings.permanentlyDelete')}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setPassword('');
                setTotpCode('');
              }}
              className="rounded-md border border-[hsl(var(--border))] px-4 py-2 text-sm hover:bg-[hsl(var(--accent))]"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const t = useT();
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
      <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
      <LanguageCard />
      <ProfilePictureCard />
      <PrivacyCard />
      <InstallAppCard />
      <CalendarFeedCard />
      <FollowRequestsCard />
      <BlockedUsersCard />
      <ModerationCard />
      <ImportCard />
      <ChangeEmailCard />
      <ChangePasswordCard />
      <TwoFactorCard />
      <EncryptionSettingsCard />
      <SessionsCard />
      <SecurityActivityCard />
      <SignOutCard />
      <Link
        to="/about"
        className="flex items-center justify-between gap-4 border-y border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <Info className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          {t('settings.aboutLink')}
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <Link
        to="/privacy"
        className="flex items-center justify-between gap-4 border-b border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          {t('privacy.title')}
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <Link
        to="/terms"
        className="flex items-center justify-between gap-4 border-b border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          {t('nav.terms')}
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <Link
        to="/community-guidelines"
        className="flex items-center justify-between gap-4 border-b border-[hsl(var(--border))] px-1 py-4 text-sm font-medium hover:text-[hsl(var(--primary))]"
      >
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          {t('nav.guidelines')}
        </span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      <DangerZoneCard />
    </div>
  );
}
