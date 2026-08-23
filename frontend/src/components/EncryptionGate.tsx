import { useId, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { useRestoreEncryption, useSetupEncryption } from '@/hooks/useEncryption';
import { useT } from '@/hooks/useT';
import { KeyMismatchError, WrongSecretError } from '@/lib/crypto/session';
import { useEncryptionStore } from '@/store/encryption';

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm">
      {children}
    </div>
  );
}

/** The recovery code, shown exactly once.
 *
 *  Nobody else has a copy — that is the point, and it is also why this cannot
 *  be a toast that scrolls away. It stays until the user says they have it. */
function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Panel>
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {t('encryption.recoveryTitle')}
      </h2>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('encryption.recoveryBody')}</p>
      <p className="mt-3 select-all break-all rounded-lg bg-[hsl(var(--muted))] px-3 py-2 font-mono text-sm tracking-wide">
        {code}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              // A browser that refuses clipboard access is not an error worth
              // reporting: the code is on screen and selectable.
              () => undefined,
            );
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))]"
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {copied ? t('encryption.copied') : t('encryption.copy')}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90"
        >
          {t('encryption.recoveryConfirm')}
        </button>
      </div>
    </Panel>
  );
}

function SetupForm() {
  const t = useT();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const setup = useSetupEncryption();

  if (recoveryCode) {
    return <RecoveryCode code={recoveryCode} onDone={() => setRecoveryCode(null)} />;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || setup.isPending) return;
    setup.mutate(password, {
      onSuccess: (result) => {
        setPassword('');
        setRecoveryCode(result.recoveryCode);
      },
    });
  };

  return (
    <Panel>
      <h2 className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {t('encryption.setupTitle')}
      </h2>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('encryption.setupBody')}</p>
      <form onSubmit={submit} className="mt-3 space-y-2">
        <label htmlFor={passwordId} className="block text-xs font-medium">
          {t('encryption.password')}
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm"
        />
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          {t('encryption.passwordHint')}
        </p>
        {setup.isError ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {t('encryption.failed')}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!password || setup.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {setup.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {setup.isPending ? t('encryption.working') : t('encryption.setupAction')}
        </button>
      </form>
    </Panel>
  );
}

function RestoreForm() {
  const t = useT();
  const secretId = useId();
  const [kind, setKind] = useState<'password' | 'recovery'>('password');
  const [secret, setSecret] = useState('');
  const restore = useRestoreEncryption();

  const errorMessage = () => {
    if (restore.error instanceof WrongSecretError) return t('encryption.wrongSecret');
    if (restore.error instanceof KeyMismatchError) return t('encryption.keyMismatch');
    return t('encryption.failed');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!secret || restore.isPending) return;
    restore.mutate({ secret, kind }, { onSuccess: () => setSecret('') });
  };

  return (
    <Panel>
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {t('encryption.restoreTitle')}
      </h2>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('encryption.restoreBody')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(['password', 'recovery'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setKind(option);
              setSecret('');
              restore.reset();
            }}
            aria-pressed={kind === option}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === option
                ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))]'
                : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]'
            }`}
          >
            {option === 'password'
              ? t('encryption.restoreWithPassword')
              : t('encryption.restoreWithCode')}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="mt-3 space-y-2">
        <label htmlFor={secretId} className="block text-xs font-medium">
          {kind === 'password' ? t('encryption.password') : t('encryption.recoveryCode')}
        </label>
        <input
          id={secretId}
          type={kind === 'password' ? 'password' : 'text'}
          autoComplete={kind === 'password' ? 'current-password' : 'off'}
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm"
        />
        {restore.isError ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {errorMessage()}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!secret || restore.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-3 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {restore.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {restore.isPending ? t('encryption.working') : t('encryption.restoreAction')}
        </button>
      </form>
    </Panel>
  );
}

/** Whatever the user has to do before this device can read messages — or
 *  nothing at all, which is the usual case. */
export function EncryptionGate() {
  const t = useT();
  const status = useEncryptionStore((state) => state.status);

  if (status === 'ready' || status === 'loading') return null;
  if (status === 'unavailable') {
    return (
      <Panel>
        <p className="text-[hsl(var(--muted-foreground))]">{t('encryption.unavailable')}</p>
      </Panel>
    );
  }
  return status === 'locked' ? <RestoreForm /> : <SetupForm />;
}
