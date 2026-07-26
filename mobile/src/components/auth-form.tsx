import { router, useLocalSearchParams } from 'expo-router';
import { Eye, EyeOff, Film } from 'lucide-react-native';
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
import { SegmentedControl } from '@/components/segmented-control';
import { radius, spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { safePostAuthRedirect } from '@/lib/deep-links';
import { getErrorMessage, isTwoFactorRequired } from '@/lib/http';
import { loginSession, registerSession } from '@/lib/session';
import {
  normalizeSecondFactorInput,
  validateSecondFactorInput,
  type SecondFactorMode,
} from '@/lib/two-factor';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const theme = useTheme();
  const t = useT();
  const secondFactorOptions = [
    { value: 'authenticator', label: t('auth.authenticatorOption') },
    { value: 'recovery', label: t('auth.recoveryOption') },
  ] as const;
  const params = useLocalSearchParams<{ redirect?: string | string[] }>();
  const redirect = safePostAuthRedirect(params.redirect);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [secondFactorMode, setSecondFactorMode] = useState<SecondFactorMode>('authenticator');
  const [secondFactorCode, setSecondFactorCode] = useState('');
  const isRegister = mode === 'register';

  const submit = async () => {
    setError(null);
    const normalizedEmail = email.trim();
    if (!normalizedEmail.includes('@')) {
      setError(t('auth.invalidEmail'));
      return;
    }
    if (isRegister && username.trim().length < 3) {
      setError(t('auth.usernameTooShort'));
      return;
    }
    if (!password || (isRegister && password.length < 8)) {
      setError(isRegister ? t('auth.passwordTooShort') : t('auth.enterPassword'));
      return;
    }
    if (isRegister && (!/[A-Za-z]/.test(password) || !/\d/.test(password))) {
      setError(t('auth.passwordNeedsLetterNumber'));
      return;
    }

    if (!isRegister && mfaRequired) {
      const validationError = validateSecondFactorInput(secondFactorMode, secondFactorCode);
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setPending(true);
    try {
      if (isRegister) {
        await registerSession(username, normalizedEmail, password);
      } else {
        await loginSession(
          normalizedEmail,
          password,
          mfaRequired ? normalizeSecondFactorInput(secondFactorCode) : undefined,
        );
      }
      router.replace(redirect ?? '/(tabs)');
    } catch (submitError) {
      if (isTwoFactorRequired(submitError)) {
        // First challenge: reveal the code field rather than showing this as a
        // credential failure — the password was already accepted.
        setMfaRequired(true);
        setError(null);
      } else {
        setError(getErrorMessage(submitError, t('auth.authFailed')));
      }
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
          <View style={styles.brand}>
            <View style={[styles.logo, { backgroundColor: theme.primarySoft }]}>
              <Film color={theme.primary} size={34} />
            </View>
            <AppText variant="title">Văzute</AppText>
            <AppText muted style={styles.center}>
              {isRegister ? t('auth.registerSubtitle') : t('auth.loginSubtitle')}
            </AppText>
          </View>

          <View style={styles.form}>
            {isRegister ? (
              <View style={styles.field}>
                <AppText variant="label">{t('auth.username')}</AppText>
                <TextInput
                  testID="auth-username"
                  accessibilityLabel={t('auth.username')}
                  value={username}
                  onChangeText={setUsername}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={50}
                  textContentType="username"
                  placeholder={t('auth.usernamePlaceholder')}
                  placeholderTextColor={theme.mutedText}
                  style={[
                    styles.input,
                    {
                      color: theme.text,
                      borderColor: theme.border,
                      backgroundColor: theme.elevated,
                    },
                  ]}
                />
              </View>
            ) : null}

            <View style={styles.field}>
              <AppText variant="label">{t('auth.email')}</AppText>
              <TextInput
                testID="auth-email"
                accessibilityLabel={t('auth.email')}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder={t('auth.emailPlaceholder')}
                placeholderTextColor={theme.mutedText}
                style={[
                  styles.input,
                  {
                    color: theme.text,
                    borderColor: theme.border,
                    backgroundColor: theme.elevated,
                  },
                ]}
              />
            </View>

            <View style={styles.field}>
              <View style={styles.passwordLabelRow}>
                <AppText variant="label">{t('auth.password')}</AppText>
                {!isRegister ? (
                  <Pressable
                    accessibilityRole="link"
                    hitSlop={8}
                    onPress={() => router.push('/(auth)/forgot-password')}
                  >
                    <AppText variant="caption" style={{ color: theme.primary }}>
                      {t('auth.forgotPassword')}
                    </AppText>
                  </Pressable>
                ) : null}
              </View>
              <View
                style={[
                  styles.passwordRow,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.elevated,
                  },
                ]}
              >
                <TextInput
                  testID="auth-password"
                  accessibilityLabel="Password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType={isRegister ? 'newPassword' : 'password'}
                  placeholder={t('auth.passwordPlaceholder')}
                  placeholderTextColor={theme.mutedText}
                  style={[styles.passwordInput, { color: theme.text }]}
                  onSubmitEditing={() => void submit()}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  hitSlop={8}
                  onPress={() => setShowPassword((visible) => !visible)}
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

            {!isRegister && mfaRequired ? (
              <View style={styles.field}>
                <SegmentedControl
                  value={secondFactorMode}
                  options={secondFactorOptions}
                  disabled={pending}
                  onChange={(value) => {
                    setSecondFactorMode(value);
                    setSecondFactorCode('');
                    setError(null);
                  }}
                />
                <AppText variant="label">
                  {secondFactorMode === 'authenticator'
                    ? t('auth.authCode')
                    : t('auth.recoveryCode')}
                </AppText>
                <TextInput
                  value={secondFactorCode}
                  onChangeText={(value) => {
                    setSecondFactorCode(value);
                    setError(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType={secondFactorMode === 'authenticator' ? 'number-pad' : 'ascii-capable'}
                  textContentType={secondFactorMode === 'authenticator' ? 'oneTimeCode' : 'none'}
                  autoComplete={secondFactorMode === 'authenticator' ? 'one-time-code' : 'off'}
                  maxLength={secondFactorMode === 'authenticator' ? 6 : 19}
                  autoFocus
                  placeholder={
                    secondFactorMode === 'authenticator'
                      ? t('auth.authCodePlaceholder')
                      : t('auth.recoveryCodePlaceholder')
                  }
                  placeholderTextColor={theme.mutedText}
                  onSubmitEditing={() => void submit()}
                  style={[
                    styles.input,
                    {
                      color: theme.text,
                      borderColor: theme.border,
                      backgroundColor: theme.elevated,
                    },
                  ]}
                />
                <AppText variant="caption" muted>
                  {secondFactorMode === 'authenticator'
                    ? t('auth.authCodeHint')
                    : t('auth.recoveryCodeHint')}
                </AppText>
              </View>
            ) : null}

            {error ? (
              <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {error}
                </AppText>
              </View>
            ) : null}

            <AppButton
              label={
                isRegister
                  ? t('auth.createAccount')
                  : mfaRequired
                    ? t('auth.verify')
                    : t('auth.signIn')
              }
              loading={pending}
              onPress={() => void submit()}
            />
          </View>

          <Pressable
            testID="auth-switch-mode"
            accessibilityRole="link"
            onPress={() => {
              const pathname = isRegister ? '/(auth)/login' : '/(auth)/register';
              router.replace(
                redirect
                  ? { pathname, params: { redirect: String(redirect) } }
                  : pathname,
              );
            }}
            style={styles.switchMode}
          >
            <AppText muted>
              {isRegister ? t('auth.haveAccount') : t('auth.newToApp')}
              <AppText variant="label" style={{ color: theme.primary }}>
                {isRegister ? t('auth.signIn') : t('auth.createAccount')}
              </AppText>
            </AppText>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    gap: spacing.xxl,
  },
  brand: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  logo: {
    width: 68,
    height: 68,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  center: {
    textAlign: 'center',
  },
  form: {
    gap: spacing.lg,
  },
  field: {
    gap: spacing.sm,
  },
  passwordLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
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
  switchMode: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
