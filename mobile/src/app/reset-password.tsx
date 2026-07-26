import { router, useLocalSearchParams } from 'expo-router';
import { CircleCheck, Eye, EyeOff, KeyRound } from 'lucide-react-native';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage, rawRequest } from '@/lib/http';
import { extractPasswordResetToken } from '@/lib/password-reset';
import { clearLocalSession } from '@/lib/session';

type ResetLinkParams = {
  token?: string | string[];
  '#'?: string | string[];
};

export default function ResetPasswordScreen() {
  const theme = useTheme();
  const t = useT();
  const params = useLocalSearchParams<ResetLinkParams>();
  const token = extractPasswordResetToken(params.token, params['#']);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!token) {
      setError(t('auth.linkMissingOrInvalid'));
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError(t('auth.passwordLength'));
      return;
    }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      setError(t('auth.passwordNeedsLetterNumber'));
      return;
    }
    if (password !== confirmation) {
      setError(t('auth.passwordsMismatch'));
      return;
    }

    setPending(true);
    try {
      await rawRequest<{ message: string }>('/auth/password/reset', {
        method: 'POST',
        body: { token, new_password: password },
      });
      await clearLocalSession();
      setPassword('');
      setConfirmation('');
      setComplete(true);
    } catch (submitError) {
      setError(getErrorMessage(submitError, t('auth.resetFailed')));
    } finally {
      setPending(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <View
            style={[
              styles.icon,
              { backgroundColor: complete ? theme.successSoft : theme.primarySoft },
            ]}
          >
            {complete ? (
              <CircleCheck color={theme.success} size={32} />
            ) : (
              <KeyRound color={theme.primary} size={32} />
            )}
          </View>
          <AppText variant="title">
            {complete ? t('auth.passwordUpdated') : t('auth.chooseNewPassword')}
          </AppText>

          {complete ? (
            <>
              <AppText muted>
                {t('auth.sessionsSignedOut')}
              </AppText>
              <AppButton
                label={t('auth.continueToSignIn')}
                onPress={() => router.replace('/(auth)/login')}
              />
            </>
          ) : !token ? (
            <>
              <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {t('auth.linkMissing')}
                </AppText>
              </View>
              <AppButton
                label={t('auth.requestNewLink')}
                onPress={() => router.replace('/(auth)/forgot-password')}
              />
            </>
          ) : (
            <View style={styles.form}>
              <PasswordField
                label={t('auth.newPassword')}
                value={password}
                showPassword={showPassword}
                onChangeText={(value) => {
                  setPassword(value);
                  setError(null);
                }}
                onToggleVisibility={() => setShowPassword((visible) => !visible)}
              />
              <PasswordField
                label={t('auth.confirmNewPassword')}
                value={confirmation}
                showPassword={showPassword}
                onChangeText={(value) => {
                  setConfirmation(value);
                  setError(null);
                }}
                onToggleVisibility={() => setShowPassword((visible) => !visible)}
                onSubmit={() => void submit()}
              />

              {error ? (
                <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                  <AppText variant="caption" style={{ color: theme.danger }}>
                    {error}
                  </AppText>
                </View>
              ) : null}

              <AppButton
                label={t('auth.setNewPassword')}
                loading={pending}
                onPress={() => void submit()}
              />
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function PasswordField({
  label,
  value,
  showPassword,
  onChangeText,
  onToggleVisibility,
  onSubmit,
}: {
  label: string;
  value: string;
  showPassword: boolean;
  onChangeText: (value: string) => void;
  onToggleVisibility: () => void;
  onSubmit?: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <View
        style={[
          styles.passwordRow,
          { borderColor: theme.border, backgroundColor: theme.elevated },
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={128}
          placeholder={t('auth.newPasswordPlaceholder')}
          placeholderTextColor={theme.mutedText}
          style={[styles.passwordInput, { color: theme.text }]}
          onSubmitEditing={onSubmit}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showPassword ? t('auth.hidePasswords') : t('auth.showPasswords')}
          hitSlop={8}
          onPress={onToggleVisibility}
          style={styles.iconButton}
        >
          {showPassword ? (
            <EyeOff color={theme.mutedText} size={20} />
          ) : (
            <Eye color={theme.mutedText} size={20} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    gap: spacing.lg,
  },
  icon: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: {
    gap: spacing.lg,
  },
  field: {
    gap: spacing.sm,
  },
  passwordRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
  },
  passwordInput: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  iconButton: {
    width: 48,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
