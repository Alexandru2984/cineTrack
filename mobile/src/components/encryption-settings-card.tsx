import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { KeyRound, MessageSquareLock } from 'lucide-react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { EncryptionGate, RecoveryCode } from '@/components/encryption-gate';
import { usePasswordCopyState, useRotateRecoveryCode } from '@/hooks/use-encryption';
import { useT } from '@/hooks/use-t';
import { encryptionHintKey } from '@/lib/encryption-hint';
import { useAuthStore } from '@/store/auth';
import { useEncryptionStore } from '@/store/encryption';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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
  const theme = useTheme();
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

  return (
    <View style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.panelHeading}>
        <KeyRound color={theme.text} size={16} />
        <AppText variant="section">{t('encryption.rotateTitle')}</AppText>
      </View>
      <AppText variant="caption" style={{ color: theme.mutedText }}>
        {hasPasswordCopy ? t('encryption.rotateUpgradeBody') : t('encryption.rotateBody')}
      </AppText>
      <TextInput
        accessibilityLabel={t('encryption.password')}
        placeholder={t('encryption.password')}
        placeholderTextColor={theme.mutedText}
        secureTextEntry
        autoCapitalize="none"
        value={password}
        onChangeText={setPassword}
        style={[styles.input, { borderColor: theme.border, color: theme.text }]}
      />
      {user?.two_factor_enabled ? (
        <TextInput
          accessibilityLabel={t('auth.authCode')}
          placeholder={t('auth.authCodePlaceholder')}
          placeholderTextColor={theme.mutedText}
          keyboardType="number-pad"
          autoCapitalize="none"
          value={totpCode}
          onChangeText={setTotpCode}
          style={[styles.input, { borderColor: theme.border, color: theme.text }]}
        />
      ) : null}
      {rotate.isError ? (
        <AppText variant="caption" style={{ color: theme.danger }}>
          {t('encryption.rotateFailed')}
        </AppText>
      ) : null}
      <AppButton
        label={rotate.isPending ? t('encryption.working') : t('encryption.rotateAction')}
        disabled={!password || rotate.isPending}
        onPress={() =>
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
          )
        }
      />
    </View>
  );
}

/** Message encryption, reachable without a conversation.
 *
 *  It was offered in exactly one place: inside a thread with somebody who could
 *  already be messaged. Direct messages need a mutual follow, so finding it
 *  needed a friend, an open conversation and a reason to look — and across
 *  eleven accounts, nobody had ever set it up.
 *
 *  The forms are reused untouched: this renders the same EncryptionGate that
 *  already handles setup, restore, the recovery code shown once, and a device
 *  that cannot store keys. It adds a door, not a second implementation of a
 *  security flow.
 */
export function EncryptionSettingsCard() {
  const t = useT();
  const theme = useTheme();
  const status = useEncryptionStore((state) => state.status);
  const { data: hasPasswordCopy = false } = usePasswordCopyState();
  const hintKey = encryptionHintKey(status);
  const hint = hintKey ? t(hintKey) : null;

  return (
    <View style={[styles.section, { borderBottomColor: theme.border }]}>
      <View style={styles.sectionHeading}>
        <MessageSquareLock color={theme.primary} size={20} />
        <View style={styles.headingCopy}>
          <AppText variant="section">{t('encryption.settingsTitle')}</AppText>
          {hint ? (
            <AppText variant="caption" muted>
              {hint}
            </AppText>
          ) : null}
        </View>
      </View>
      {/* Renders nothing once a key is loaded, which is why the hint above
          carries the state rather than relying on the gate to show something. */}
      <EncryptionGate />
      {/* Only a device holding the key can seal it under a new code, so this
          appears once the key is loaded and not before. An account still
          carrying the password copy is told why it matters; one that is not is
          simply offered the rotation. */}
      {status === 'ready' ? <RotateRecoveryCode /> : null}
      {status === 'locked' && hasPasswordCopy ? (
        <AppText variant="caption" muted>
          {t('encryption.rotateLocked')}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  panelHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  section: {
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeading: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
});
