import { router } from 'expo-router';
import { MailCheck } from 'lucide-react-native';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage, rawRequest } from '@/lib/http';

export default function ForgotPasswordScreen() {
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const normalizedEmail = email.trim();
    setError(null);
    if (!normalizedEmail.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setPending(true);
    try {
      await rawRequest('/auth/password/forgot', {
        method: 'POST',
        body: { email: normalizedEmail },
      });
      setSent(true);
    } catch (submitError) {
      setError(getErrorMessage(submitError, 'The reset request could not be sent'));
    } finally {
      setPending(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.content}
      >
        <View style={[styles.icon, { backgroundColor: theme.infoSoft }]}>
          <MailCheck color={theme.info} size={30} />
        </View>
        <AppText variant="title">Reset password</AppText>

        {sent ? (
          <>
            <AppText muted>
              Check your inbox. The reset link is valid for a limited time.
            </AppText>
            <AppButton
              label="Back to sign in"
              onPress={() => router.replace('/(auth)/login')}
            />
          </>
        ) : (
          <>
            <View style={styles.field}>
              <AppText variant="label">Email</AppText>
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                textContentType="emailAddress"
                placeholder="you@example.com"
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
            </View>
            {error ? (
              <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {error}
                </AppText>
              </View>
            ) : null}
            <AppButton
              label="Send reset link"
              loading={pending}
              onPress={() => void submit()}
            />
            <Pressable
              accessibilityRole="link"
              onPress={() => router.replace('/(auth)/login')}
              style={styles.back}
            >
              <AppText variant="label" style={{ color: theme.primary }}>
                Back to sign in
              </AppText>
            </Pressable>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },
  icon: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  error: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  back: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
