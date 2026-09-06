import { useId, useState, type FormEvent } from 'react';
import { KeyRound, Loader2, MessageSquareLock } from 'lucide-react';

import { EncryptionGate, RecoveryCode } from '@/components/EncryptionGate';
import { usePasswordCopyState, useRotateRecoveryCode } from '@/hooks/useEncryption';
import { useT } from '@/hooks/useT';
import { useAuthStore } from '@/store/auth';
import { useEncryptionStore } from '@/store/encryption';

/** Replace the recovery code, and with it the last copy the server could open.
 *
 *  Two jobs in one form, because they are the same operation. Rotating a code
 *  somebody has seen is the ordinary reason to be here; the other is the
 *  upgrade for accounts set up while the key was also sealed under the account
 *  password — a password this server receives at every sign-in. That copy is
 *  dropped in the same transaction that stores the new wrap, so it survives
 *  exactly as long as its owner still needs it. */
function RotateRecoveryCode() {
  const t = useT();
  const passwordId = useId();
  const codeId = useId();
  const user = useAuthStore((state) => state.user);
  const { data: hasPasswordCopy = false } = usePasswordCopyState();
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const rotate = useRotateRecoveryCode();

  if (issued) {
    return (
      <RecoveryCode
        code={issued}
        onDone={() => setIssued(null)}
        title={t('encryption.newCodeTitle')}
        body={t('encryption.newCodeBody')}
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password || rotate.isPending) return;
    rotate.mutate(
      {
        currentPassword: password,
        ...(user?.two_factor_enabled ? { totpCode: totpCode.trim() } : {}),
      },
      {
        onSuccess: (code) => {
          setPassword('');
          setTotpCode('');
          setIssued(code);
        },
      },
    );
  };

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        {t('encryption.rotateTitle')}
      </h3>
      <p className="mt-2 text-[hsl(var(--muted-foreground))]">
        {hasPasswordCopy ? t('encryption.rotateUpgradeBody') : t('encryption.rotateBody')}
      </p>
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
        {user?.two_factor_enabled ? (
          <>
            <label htmlFor={codeId} className="block text-xs font-medium">
              {t('auth.authCode')}
            </label>
            <input
              id={codeId}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2 text-sm"
            />
          </>
        ) : null}
        {rotate.isError ? (
          <p role="alert" className="text-xs text-[hsl(var(--destructive))]">
            {t('encryption.rotateFailed')}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!password || rotate.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-60"
        >
          {rotate.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {rotate.isPending ? t('encryption.working') : t('encryption.rotateAction')}
        </button>
      </form>
    </div>
  );
}

/** Message encryption, reachable without a conversation.
 *
 *  It was previously offered in exactly one place: above the composer, inside a
 *  thread with someone who can already be messaged. Direct messages need a
 *  mutual follow, so finding it required a friend, a thread, and a reason to
 *  look — and no account had ever set encryption up.
 *
 *  The forms themselves are reused untouched. This only adds a door. */
export function EncryptionSettingsCard() {
  const t = useT();
  const status = useEncryptionStore((state) => state.status);
  const { data: hasPasswordCopy = false } = usePasswordCopyState();

  const description = () => {
    if (status === 'ready') return t('encryption.settingsReady');
    if (status === 'locked') return t('encryption.settingsLocked');
    if (status === 'absent') return t('encryption.settingsAbsent');
    // 'loading' and 'unavailable' say nothing here: the first is momentary and
    // the second is explained by the gate itself, in more detail than a
    // subtitle has room for.
    return null;
  };

  const hint = description();

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <MessageSquareLock className="h-5 w-5 text-[hsl(var(--primary))]" />{' '}
        {t('encryption.settingsTitle')}
      </h2>
      {hint ? (
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{hint}</p>
      ) : null}
      {/* Renders nothing once the key is loaded, which is why the line above
          carries the state rather than relying on the gate to show something. */}
      <div className="mt-4 empty:mt-0">
        <EncryptionGate />
      </div>
      {/* Only a device holding the key can seal it under a new code, so this
          appears once the key is loaded and not before. An account still
          carrying the password copy is told why it matters; one that is not is
          simply offered the rotation. */}
      {status === 'ready' ? (
        <div className="mt-4">
          <RotateRecoveryCode />
        </div>
      ) : null}
      {status === 'locked' && hasPasswordCopy ? (
        <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
          {t('encryption.rotateLocked')}
        </p>
      ) : null}
    </section>
  );
}
