import { MessageSquareLock } from 'lucide-react';

import { EncryptionGate } from '@/components/EncryptionGate';
import { useT } from '@/hooks/useT';
import { useEncryptionStore } from '@/store/encryption';

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
    </section>
  );
}
