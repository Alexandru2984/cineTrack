import { KeyRound, ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useRestoreEncryption, useSetupEncryption } from '@/hooks/use-encryption';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { KeyMismatchError, WrongSecretError } from '@/lib/crypto/session';
import { useEncryptionStore } from '@/store/encryption';

function Panel({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {children}
    </View>
  );
}

/** The recovery code, shown exactly once.
 *
 *  Nobody else has a copy — that is the point, and it is also why this stays on
 *  screen until the user says they have it rather than passing by in a toast. */
function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const t = useT();
  const theme = useTheme();

  return (
    <Panel>
      <View style={styles.heading}>
        <KeyRound color={theme.text} size={16} />
        <AppText variant="section">{t('encryption.recoveryTitle')}</AppText>
      </View>
      <AppText variant="caption" style={{ color: theme.mutedText }}>
        {t('encryption.recoveryBody')}
      </AppText>
      <AppText selectable style={[styles.code, { backgroundColor: theme.background }]}>
        {code}
      </AppText>
      {/* Selectable rather than copyable: a clipboard dependency for one
          button is not worth carrying, and a recovery code that sits in the
          clipboard is not obviously an improvement anyway. */}
      <AppButton label={t('encryption.recoveryConfirm')} onPress={onDone} />
    </Panel>
  );
}

function SetupForm() {
  const t = useT();
  const theme = useTheme();
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const setup = useSetupEncryption();

  if (recoveryCode) {
    return <RecoveryCode code={recoveryCode} onDone={() => setRecoveryCode(null)} />;
  }

  return (
    <Panel>
      <View style={styles.heading}>
        <ShieldCheck color={theme.text} size={16} />
        <AppText variant="section">{t('encryption.setupTitle')}</AppText>
      </View>
      <AppText variant="caption" style={{ color: theme.mutedText }}>
        {t('encryption.setupBody')}
      </AppText>
      <TextInput
        accessibilityLabel={t('encryption.password')}
        placeholder={t('encryption.password')}
        placeholderTextColor={theme.mutedText}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={[styles.input, { borderColor: theme.border, color: theme.text }]}
      />
      <AppText variant="caption" style={{ color: theme.mutedText }}>
        {t('encryption.passwordHint')}
      </AppText>
      {setup.isError ? (
        <AppText variant="caption" style={{ color: theme.danger }}>
          {t('encryption.failed')}
        </AppText>
      ) : null}
      <AppButton
        label={setup.isPending ? t('encryption.working') : t('encryption.setupAction')}
        disabled={!password || setup.isPending}
        onPress={() =>
          setup.mutate(password, {
            onSuccess: (result) => {
              setPassword('');
              setRecoveryCode(result.recoveryCode);
            },
          })
        }
      />
    </Panel>
  );
}

function RestoreForm() {
  const t = useT();
  const theme = useTheme();
  const [kind, setKind] = useState<'password' | 'recovery'>('password');
  const [secret, setSecret] = useState('');
  const restore = useRestoreEncryption();

  const errorMessage = () => {
    if (restore.error instanceof WrongSecretError) return t('encryption.wrongSecret');
    if (restore.error instanceof KeyMismatchError) return t('encryption.keyMismatch');
    return t('encryption.failed');
  };

  return (
    <Panel>
      <View style={styles.heading}>
        <KeyRound color={theme.text} size={16} />
        <AppText variant="section">{t('encryption.restoreTitle')}</AppText>
      </View>
      <AppText variant="caption" style={{ color: theme.mutedText }}>
        {t('encryption.restoreBody')}
      </AppText>
      <View style={styles.actions}>
        {(['password', 'recovery'] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === option }}
            onPress={() => {
              setKind(option);
              setSecret('');
              restore.reset();
            }}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: kind === option ? theme.primary : theme.border,
                opacity: pressed ? 0.6 : 1,
              },
            ]}
          >
            <AppText variant="caption">
              {option === 'password'
                ? t('encryption.restoreWithPassword')
                : t('encryption.restoreWithCode')}
            </AppText>
          </Pressable>
        ))}
      </View>
      <TextInput
        accessibilityLabel={
          kind === 'password' ? t('encryption.password') : t('encryption.recoveryCode')
        }
        placeholder={kind === 'password' ? t('encryption.password') : t('encryption.recoveryCode')}
        placeholderTextColor={theme.mutedText}
        secureTextEntry={kind === 'password'}
        autoCapitalize="none"
        value={secret}
        onChangeText={setSecret}
        style={[styles.input, { borderColor: theme.border, color: theme.text }]}
      />
      {restore.isError ? (
        <AppText variant="caption" style={{ color: theme.danger }}>
          {errorMessage()}
        </AppText>
      ) : null}
      <AppButton
        label={restore.isPending ? t('encryption.working') : t('encryption.restoreAction')}
        disabled={!secret || restore.isPending}
        onPress={() => restore.mutate({ secret, kind }, { onSuccess: () => setSecret('') })}
      />
    </Panel>
  );
}

/** Whatever the user has to do before this device can read messages — or
 *  nothing at all, which is the usual case. */
export function EncryptionGate() {
  const t = useT();
  const theme = useTheme();
  const status = useEncryptionStore((state) => state.status);

  if (status === 'ready' || status === 'loading') return null;
  if (status === 'unavailable') {
    return (
      <Panel>
        <AppText variant="caption" style={{ color: theme.mutedText }}>
          {t('encryption.unavailable')}
        </AppText>
      </Panel>
    );
  }
  return status === 'locked' ? <RestoreForm /> : <SetupForm />;
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  code: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: 'monospace',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  choice: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
});
