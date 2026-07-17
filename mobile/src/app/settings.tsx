import { Redirect, router } from 'expo-router';
import { AlertTriangle, Eye, EyeOff, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import {
  Alert,
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
import { useTheme } from '@/hooks/use-theme';
import { deleteAccountSession } from '@/lib/account';
import { getErrorMessage } from '@/lib/http';
import { useAuthStore } from '@/store/auth';

export default function SettingsScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'authenticated' || !user) return <Redirect href="/" />;

  const deleteAccount = async () => {
    setPending(true);
    setError(null);
    try {
      await deleteAccountSession(password);
      router.replace('/');
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, 'Could not delete your account'));
    } finally {
      setPending(false);
    }
  };

  const confirmDeletion = () => {
    setError(null);
    if (!password) {
      setError('Enter your current password');
      return;
    }
    if (password.length > 128) {
      setError('Password must contain at most 128 characters');
      return;
    }

    Alert.alert(
      'Permanently delete account?',
      'Your profile, library, watch history, lists, social data, and sessions will be deleted. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: () => void deleteAccount(),
        },
      ],
    );
  };

  const cancelDeletion = () => {
    setConfirming(false);
    setPassword('');
    setShowPassword(false);
    setError(null);
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <View style={styles.accountSummary}>
            <AppText variant="section">Your account</AppText>
            <View style={[styles.summaryRow, { borderColor: theme.border }]}>
              <View style={styles.summaryCopy}>
                <AppText variant="label">{user.username}</AppText>
                <AppText variant="caption" muted numberOfLines={2}>
                  {user.email}
                </AppText>
              </View>
            </View>
          </View>

          <View style={[styles.dangerZone, { borderColor: theme.danger }]}>
            <View style={styles.dangerHeading}>
              <AlertTriangle color={theme.danger} size={20} />
              <AppText variant="section" style={{ color: theme.danger }}>
                Delete account
              </AppText>
            </View>
            <AppText muted>
              Permanently deletes your Văzute account and all associated data.
              This action cannot be undone.
            </AppText>

            {!confirming ? (
              <AppButton
                label="Delete my account"
                icon={<Trash2 color="#FFFFFF" size={18} />}
                variant="danger"
                onPress={() => setConfirming(true)}
              />
            ) : (
              <View style={styles.confirmation}>
                <View style={styles.field}>
                  <AppText variant="label">Current password</AppText>
                  <View
                    style={[
                      styles.passwordRow,
                      {
                        borderColor: error ? theme.danger : theme.border,
                        backgroundColor: theme.elevated,
                      },
                    ]}
                  >
                    <TextInput
                      value={password}
                      onChangeText={(value) => {
                        setPassword(value);
                        setError(null);
                      }}
                      secureTextEntry={!showPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="current-password"
                      textContentType="password"
                      maxLength={128}
                      placeholder="Password"
                      placeholderTextColor={theme.mutedText}
                      style={[styles.passwordInput, { color: theme.text }]}
                      onSubmitEditing={confirmDeletion}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
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

                {error ? (
                  <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                    <AppText variant="caption" style={{ color: theme.danger }}>
                      {error}
                    </AppText>
                  </View>
                ) : null}

                <View style={styles.actions}>
                  <View style={styles.action}>
                    <AppButton
                      label="Permanently delete"
                      icon={<Trash2 color="#FFFFFF" size={18} />}
                      variant="danger"
                      loading={pending}
                      onPress={confirmDeletion}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label="Cancel"
                      variant="secondary"
                      disabled={pending}
                      onPress={cancelDeletion}
                    />
                  </View>
                </View>
              </View>
            )}
          </View>
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
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.xxl,
  },
  accountSummary: {
    gap: spacing.md,
  },
  summaryRow: {
    minHeight: 64,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  summaryCopy: {
    minWidth: 0,
    gap: spacing.xs,
  },
  dangerZone: {
    gap: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  dangerHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  confirmation: {
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
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  action: {
    flexGrow: 1,
    flexBasis: 180,
  },
});
