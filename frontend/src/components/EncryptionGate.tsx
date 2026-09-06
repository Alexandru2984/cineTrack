import { useId, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import {
  usePasswordCopyState,
  useRestoreEncryption,
  useSetupEncryption,
} from '@/hooks/useEncryption';
import { useT } from '@/hooks/useT';
import {
  KeyMismatchError,
  PasswordRestoreUnavailableError,
  WrongSecretError,
} from '@/lib/crypto/session';
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
export function RecoveryCode({
  code,
  onDone,
  title,
  body,
}: {
  code: string;
  onDone: () => void;
  title?: string;
  body?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Panel>
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {title ?? t('encryption.recoveryTitle')}
      </h2>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">
        {body ?? t('encryption.recoveryBody')}
      </p>
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

/** Turning encryption on.
 *
 *  It used to ask for the account password, to seal a second copy of the key
 *  with it. Nothing is derived from the password any more, so there is nothing
 *  to ask for: the button generates the identity and the recovery code that
 *  opens it. */
function SetupForm() {
  const t = useT();
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const setup = useSetupEncryption();

  if (recoveryCode) {
    return <RecoveryCode code={recoveryCode} onDone={() => setRecoveryCode(null)} />;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (setup.isPending) return;
    setup.mutate(undefined, {
      onSuccess: (result) => setRecoveryCode(result.recoveryCode),
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
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{t('encryption.setupHint')}</p>
        {setup.isError ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {t('encryption.failed')}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={setup.isPending}
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
  // The password is offered only to accounts that still have a copy it opens —
  // everyone set up since the copy was removed, and everyone who has completed
  // the upgrade, has the recovery code and nothing else. Offering a choice that
  // cannot work would send people to hunt for a password that was never going
  // to unlock anything.
  const { data: hasPasswordCopy = false } = usePasswordCopyState();
  const [kind, setKind] = useState<'password' | 'recovery'>('recovery');
  const [secret, setSecret] = useState('');
  const restore = useRestoreEncryption();

  const options = hasPasswordCopy ? (['password', 'recovery'] as const) : (['recovery'] as const);
  const active = hasPasswordCopy ? kind : 'recovery';

  const errorMessage = () => {
    if (restore.error instanceof WrongSecretError) return t('encryption.wrongSecret');
    if (restore.error instanceof KeyMismatchError) return t('encryption.keyMismatch');
    if (restore.error instanceof PasswordRestoreUnavailableError) {
      return t('encryption.passwordUnavailable');
    }
    return t('encryption.failed');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!secret || restore.isPending) return;
    restore.mutate({ secret, kind: active }, { onSuccess: () => setSecret('') });
  };

  return (
    <Panel>
      <h2 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {t('encryption.restoreTitle')}
      </h2>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">{t('encryption.restoreBody')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setKind(option);
              setSecret('');
              restore.reset();
            }}
            aria-pressed={active === option}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              active === option
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
          {active === 'password' ? t('encryption.password') : t('encryption.recoveryCode')}
        </label>
        <input
          id={secretId}
          type={active === 'password' ? 'password' : 'text'}
          autoComplete={active === 'password' ? 'current-password' : 'off'}
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
