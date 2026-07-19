import { Redirect, router } from 'expo-router';
import {
  AlertTriangle,
  Bell,
  ExternalLink,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Laptop2,
  LogOut,
  MailWarning,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { SegmentedControl } from '@/components/segmented-control';
import { radius, spacing } from '@/constants/theme';
import {
  useAccountSessions,
  useChangeAccountPassword,
  useLogoutAllAccountSessions,
  useResendEmailVerification,
  useRevokeAccountSession,
  useUpdateAccountProfile,
} from '@/hooks/use-account';
import {
  useCalendarPreferences,
  useUpdateCalendarPreferences,
} from '@/hooks/use-calendar';
import { useReleaseNotifications } from '@/hooks/use-release-notifications';
import { useTheme } from '@/hooks/use-theme';
import {
  deleteAccountSession,
  MAX_PROFILE_BIO_LENGTH,
  validatePasswordChange,
  validateProfileDraft,
} from '@/lib/account';
import { formatDateTime } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { useAuthStore } from '@/store/auth';
import type { AccountSession } from '@/types';

const COUNTRY_OPTIONS: readonly { value: string; label: string; name: string }[] = [
  { value: 'RO', label: 'RO', name: 'Romania' },
  { value: 'US', label: 'US', name: 'United States' },
  { value: 'GB', label: 'GB', name: 'United Kingdom' },
  { value: 'DE', label: 'DE', name: 'Germany' },
  { value: 'FR', label: 'FR', name: 'France' },
  { value: 'IT', label: 'IT', name: 'Italy' },
  { value: 'ES', label: 'ES', name: 'Spain' },
  { value: 'NL', label: 'NL', name: 'Netherlands' },
  { value: 'SE', label: 'SE', name: 'Sweden' },
  { value: 'PL', label: 'PL', name: 'Poland' },
  { value: 'CA', label: 'CA', name: 'Canada' },
  { value: 'AU', label: 'AU', name: 'Australia' },
  { value: 'JP', label: 'JP', name: 'Japan' },
  { value: 'KR', label: 'KR', name: 'South Korea' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const updateProfile = useUpdateAccountProfile();
  const preferences = useCalendarPreferences(status === 'authenticated');
  const updatePreferences = useUpdateCalendarPreferences();
  const sessions = useAccountSessions(status === 'authenticated');
  const revokeSession = useRevokeAccountSession();
  const logoutAllSessions = useLogoutAllAccountSessions();
  const changePassword = useChangeAccountPassword();
  const resendVerification = useResendEmailVerification();
  const releaseAlerts = useReleaseNotifications(
    user?.id ?? '',
    status === 'authenticated',
  );

  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [isPublic, setIsPublic] = useState(user?.is_public ?? false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [showDeletionPassword, setShowDeletionPassword] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  if (status !== 'authenticated' || !user) return <Redirect href="/" />;

  const profileDirty =
    username.trim() !== user.username ||
    bio.trim() !== (user.bio ?? '') ||
    isPublic !== user.is_public;
  const countryCode =
    (updatePreferences.isPending ? updatePreferences.variables : undefined) ??
    preferences.data?.country_code ??
    'RO';
  const countryName =
    COUNTRY_OPTIONS.find((country) => country.value === countryCode)?.name ?? countryCode;

  const saveProfile = async () => {
    const validationError = validateProfileDraft(username, bio);
    if (validationError) {
      setProfileError(validationError);
      return;
    }
    setProfileError(null);
    setProfileSaved(false);
    try {
      const updated = await updateProfile.mutateAsync({ username, bio, isPublic });
      setUsername(updated.username);
      setBio(updated.bio ?? '');
      setIsPublic(updated.is_public);
      setProfileSaved(true);
    } catch (error) {
      setProfileError(getErrorMessage(error, 'Could not update your profile'));
    }
  };

  const submitPasswordChange = async () => {
    const validationError = validatePasswordChange(
      currentPassword,
      newPassword,
      passwordConfirmation,
    );
    if (validationError) {
      setPasswordError(validationError);
      return;
    }
    setPasswordError(null);
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      router.replace('/');
      Alert.alert('Password updated', 'Sign in again with your new password.');
    } catch (error) {
      setPasswordError(getErrorMessage(error, 'Could not change your password'));
    }
  };

  const confirmLogoutAll = () => {
    setSessionsError(null);
    Alert.alert(
      'Sign out everywhere?',
      'Every active session, including this device, will need to sign in again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out everywhere',
          style: 'destructive',
          onPress: () => {
            void logoutAllSessions
              .mutateAsync()
              .then(() => router.replace('/'))
              .catch((error) => {
                setSessionsError(getErrorMessage(error, 'Could not close all sessions'));
              });
          },
        },
      ],
    );
  };

  const deleteAccount = async () => {
    setDeletionPending(true);
    setDeletionError(null);
    try {
      await deleteAccountSession(deletionPassword);
      router.replace('/');
    } catch (error) {
      setDeletionError(getErrorMessage(error, 'Could not delete your account'));
    } finally {
      setDeletionPending(false);
    }
  };

  const confirmDeletion = () => {
    setDeletionError(null);
    if (!deletionPassword) {
      setDeletionError('Enter your current password');
      return;
    }
    if (deletionPassword.length > 128) {
      setDeletionError('Password must contain at most 128 characters');
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
    setConfirmingDeletion(false);
    setDeletionPassword('');
    setShowDeletionPassword(false);
    setDeletionError(null);
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
          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <UserRound color={theme.primary} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">Profile & privacy</AppText>
                <AppText variant="caption" muted numberOfLines={2}>
                  {user.email}
                </AppText>
              </View>
            </View>

            <View style={styles.field}>
              <AppText variant="label">Username</AppText>
              <TextInput
                value={username}
                onChangeText={(value) => {
                  setUsername(value);
                  setProfileError(null);
                  setProfileSaved(false);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={50}
                placeholder="Username"
                placeholderTextColor={theme.mutedText}
                style={[
                  styles.textInput,
                  { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated },
                ]}
              />
            </View>

            <View style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <AppText variant="label">Bio</AppText>
                <AppText variant="caption" muted>
                  {Array.from(bio).length}/{MAX_PROFILE_BIO_LENGTH}
                </AppText>
              </View>
              <TextInput
                value={bio}
                onChangeText={(value) => {
                  setBio(value);
                  setProfileError(null);
                  setProfileSaved(false);
                }}
                multiline
                maxLength={MAX_PROFILE_BIO_LENGTH}
                placeholder="A short introduction"
                placeholderTextColor={theme.mutedText}
                textAlignVertical="top"
                style={[
                  styles.textInput,
                  styles.bioInput,
                  { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated },
                ]}
              />
            </View>

            <View style={[styles.switchRow, { borderColor: theme.border }]}>
              <View style={styles.switchCopy}>
                <AppText variant="label">Public profile</AppText>
                <AppText variant="caption" muted>
                  Allow other people to discover your profile and activity.
                </AppText>
              </View>
              <Switch
                accessibilityLabel="Public profile"
                value={isPublic}
                disabled={updateProfile.isPending}
                onValueChange={(value) => {
                  setIsPublic(value);
                  setProfileError(null);
                  setProfileSaved(false);
                }}
                trackColor={{ false: theme.border, true: theme.primarySoft }}
                thumbColor={isPublic ? theme.primary : theme.mutedText}
              />
            </View>

            {profileError ? <FormMessage message={profileError} /> : null}
            {profileSaved ? <FormMessage message="Profile updated" success /> : null}
            <AppButton
              label="Save profile"
              icon={<Save color="#FFFFFF" size={18} />}
              loading={updateProfile.isPending}
              disabled={!profileDirty}
              onPress={() => void saveProfile()}
            />
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <Globe2 color={theme.info} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">Release region</AppText>
                <AppText variant="caption" muted>
                  {countryName} ({countryCode})
                </AppText>
              </View>
            </View>
            <AppText muted>
              Used for regional movie dates in Upcoming.
            </AppText>
            {preferences.isLoading ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <SegmentedControl
                value={countryCode}
                options={COUNTRY_OPTIONS}
                disabled={updatePreferences.isPending}
                onChange={(value) => updatePreferences.mutate(value)}
              />
            )}
            {preferences.isError ? (
              <FormMessage message="Could not load your release region" />
            ) : null}
            {updatePreferences.error ? (
              <FormMessage
                message={getErrorMessage(updatePreferences.error, 'Could not update the region')}
              />
            ) : null}
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <Bell color={theme.primary} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">Release alerts</AppText>
                <AppText variant="caption" muted>
                  Episodes and planned movie releases.
                </AppText>
              </View>
            </View>
            <View style={[styles.switchRow, { borderColor: theme.border }]}>
              <View style={styles.switchCopy}>
                <AppText variant="label">
                  {releaseAlerts.state.enabled ? 'On' : 'Off'}
                </AppText>
                <AppText variant="caption" muted>
                  {releaseAlerts.state.permission === 'denied'
                    ? 'Blocked in system settings.'
                    : releaseAlerts.state.permission === 'unavailable' ||
                        releaseAlerts.state.permission === 'unsupported'
                      ? 'Unavailable in this build.'
                      : releaseAlerts.state.pending
                        ? 'Waiting to finish registration.'
                        : 'New releases from your library.'}
                </AppText>
              </View>
              {releaseAlerts.isLoading ? (
                <ActivityIndicator color={theme.primary} />
              ) : (
                <Switch
                  accessibilityLabel="Release alerts"
                  value={releaseAlerts.state.enabled}
                  disabled={
                    releaseAlerts.isUpdating ||
                    (!releaseAlerts.state.enabled &&
                      (releaseAlerts.state.permission === 'unavailable' ||
                        releaseAlerts.state.permission === 'unsupported'))
                  }
                  onValueChange={(value) => {
                    if (
                      value &&
                      releaseAlerts.state.permission === 'denied' &&
                      !releaseAlerts.state.canAskAgain
                    ) {
                      void Linking.openSettings();
                      return;
                    }
                    void releaseAlerts.setEnabled(value);
                  }}
                  trackColor={{ false: theme.border, true: theme.primarySoft }}
                  thumbColor={
                    releaseAlerts.state.enabled ? theme.primary : theme.mutedText
                  }
                />
              )}
            </View>
            {releaseAlerts.error ? (
              <FormMessage message={releaseAlerts.error} />
            ) : null}
            {releaseAlerts.state.permission === 'denied' ? (
              <AppButton
                label="Open system settings"
                icon={<ExternalLink color={theme.text} size={18} />}
                variant="secondary"
                onPress={() => void Linking.openSettings()}
              />
            ) : null}
          </View>

          {user.email_verified === false ? (
            <View style={[styles.section, { borderBottomColor: theme.border }]}>
              <View style={styles.sectionHeading}>
                <MailWarning color={theme.warning} size={20} />
                <View style={styles.headingCopy}>
                  <AppText variant="section">Confirm your email</AppText>
                  <AppText variant="caption" muted numberOfLines={2}>
                    Secures your account and password recovery for {user.email}.
                  </AppText>
                </View>
              </View>
              {resendVerification.isSuccess ? (
                <FormMessage message="Confirmation link sent. Check your inbox." success />
              ) : null}
              {resendVerification.isError ? (
                <FormMessage
                  message={getErrorMessage(resendVerification.error, 'Could not send the link')}
                />
              ) : null}
              <AppButton
                label={resendVerification.isSuccess ? 'Link sent' : 'Resend confirmation email'}
                icon={<MailWarning color="#FFFFFF" size={18} />}
                loading={resendVerification.isPending}
                disabled={resendVerification.isSuccess}
                onPress={() => resendVerification.mutate()}
              />
            </View>
          ) : null}

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <KeyRound color={theme.warning} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">Change password</AppText>
                <AppText variant="caption" muted>
                  Updating it signs out every device.
                </AppText>
              </View>
            </View>
            <PasswordField
              label="Current password"
              value={currentPassword}
              visible={showPasswords}
              autoComplete="current-password"
              onChange={(value) => {
                setCurrentPassword(value);
                setPasswordError(null);
              }}
              onToggleVisibility={() => setShowPasswords((visible) => !visible)}
            />
            <PasswordField
              label="New password"
              value={newPassword}
              visible={showPasswords}
              autoComplete="new-password"
              onChange={(value) => {
                setNewPassword(value);
                setPasswordError(null);
              }}
              onToggleVisibility={() => setShowPasswords((visible) => !visible)}
            />
            <PasswordField
              label="Confirm new password"
              value={passwordConfirmation}
              visible={showPasswords}
              autoComplete="new-password"
              onChange={(value) => {
                setPasswordConfirmation(value);
                setPasswordError(null);
              }}
              onToggleVisibility={() => setShowPasswords((visible) => !visible)}
              onSubmit={submitPasswordChange}
            />
            {passwordError ? <FormMessage message={passwordError} /> : null}
            <AppButton
              label="Update password"
              icon={<KeyRound color="#FFFFFF" size={18} />}
              loading={changePassword.isPending}
              onPress={() => void submitPasswordChange()}
            />
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionHeading}>
                <Laptop2 color={theme.success} size={20} />
                <View style={styles.headingCopy}>
                  <AppText variant="section">Active sessions</AppText>
                  <AppText variant="caption" muted>
                    Devices that can access your account.
                  </AppText>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh active sessions"
                disabled={sessions.isFetching}
                onPress={() => void sessions.refetch()}
                style={({ pressed }) => [
                  styles.iconButton,
                  { opacity: sessions.isFetching ? 0.45 : pressed ? 0.7 : 1 },
                ]}
              >
                <RefreshCw color={theme.mutedText} size={20} />
              </Pressable>
            </View>

            {sessions.isLoading ? (
              <ActivityIndicator color={theme.primary} />
            ) : sessions.isError ? (
              <FormMessage
                message={getErrorMessage(sessions.error, 'Could not load active sessions')}
              />
            ) : sessions.data?.length === 0 ? (
              <AppText muted>No active sessions found.</AppText>
            ) : (
              <View style={[styles.sessionList, { borderTopColor: theme.border }]}>
                {sessions.data?.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    pending={revokeSession.isPending && revokeSession.variables === session.id}
                    onRevoke={() => {
                      setSessionsError(null);
                      revokeSession.mutate(session.id, {
                        onError: (error) => {
                          setSessionsError(
                            getErrorMessage(error, 'Could not revoke this session'),
                          );
                        },
                      });
                    }}
                  />
                ))}
              </View>
            )}
            {sessionsError ? <FormMessage message={sessionsError} /> : null}
            <AppButton
              label="Sign out everywhere"
              icon={<LogOut color="#FFFFFF" size={18} />}
              variant="danger"
              loading={logoutAllSessions.isPending}
              onPress={confirmLogoutAll}
            />
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <ShieldCheck color={theme.info} size={20} />
              <AppText variant="section">Privacy & data</AppText>
            </View>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open Văzute privacy policy"
              onPress={() => void Linking.openURL('https://vazute.micutu.com/privacy')}
              style={({ pressed }) => [
                styles.linkRow,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <AppText variant="label">Privacy policy</AppText>
              <ExternalLink color={theme.mutedText} size={18} />
            </Pressable>
          </View>

          <View style={[styles.dangerZone, { borderColor: theme.danger }]}>
            <View style={styles.sectionHeading}>
              <AlertTriangle color={theme.danger} size={20} />
              <AppText variant="section" style={{ color: theme.danger }}>
                Delete account
              </AppText>
            </View>
            <AppText muted>
              Permanently deletes your Văzute account and all associated data.
              This action cannot be undone.
            </AppText>

            {!confirmingDeletion ? (
              <AppButton
                label="Delete my account"
                icon={<Trash2 color="#FFFFFF" size={18} />}
                variant="danger"
                onPress={() => setConfirmingDeletion(true)}
              />
            ) : (
              <View style={styles.confirmation}>
                <PasswordField
                  label="Current password"
                  value={deletionPassword}
                  visible={showDeletionPassword}
                  autoComplete="current-password"
                  onChange={(value) => {
                    setDeletionPassword(value);
                    setDeletionError(null);
                  }}
                  onToggleVisibility={() => setShowDeletionPassword((visible) => !visible)}
                  onSubmit={confirmDeletion}
                />
                {deletionError ? <FormMessage message={deletionError} /> : null}
                <View style={styles.actions}>
                  <View style={styles.action}>
                    <AppButton
                      label="Permanently delete"
                      icon={<Trash2 color="#FFFFFF" size={18} />}
                      variant="danger"
                      loading={deletionPending}
                      onPress={confirmDeletion}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label="Cancel"
                      variant="secondary"
                      disabled={deletionPending}
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

function PasswordField({
  label,
  value,
  visible,
  autoComplete,
  onChange,
  onToggleVisibility,
  onSubmit,
}: {
  label: string;
  value: string;
  visible: boolean;
  autoComplete: 'current-password' | 'new-password';
  onChange: (value: string) => void;
  onToggleVisibility: () => void;
  onSubmit?: () => void;
}) {
  const theme = useTheme();
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
          onChangeText={onChange}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          textContentType={autoComplete === 'current-password' ? 'password' : 'newPassword'}
          maxLength={128}
          placeholder="Password"
          placeholderTextColor={theme.mutedText}
          style={[styles.passwordInput, { color: theme.text }]}
          onSubmitEditing={onSubmit}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? 'Hide passwords' : 'Show passwords'}
          hitSlop={8}
          onPress={onToggleVisibility}
          style={styles.iconButton}
        >
          {visible ? (
            <EyeOff color={theme.mutedText} size={20} />
          ) : (
            <Eye color={theme.mutedText} size={20} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function SessionRow({
  session,
  pending,
  onRevoke,
}: {
  session: AccountSession;
  pending: boolean;
  onRevoke: () => void;
}) {
  const theme = useTheme();
  const looksMobile = /android|ios|mobile|okhttp/i.test(session.user_agent ?? '');
  const DeviceIcon = looksMobile ? Smartphone : Laptop2;
  return (
    <View style={[styles.sessionRow, { borderBottomColor: theme.border }]}>
      <View style={[styles.deviceIcon, { backgroundColor: theme.surface }]}>
        <DeviceIcon color={theme.mutedText} size={20} />
      </View>
      <View style={styles.sessionCopy}>
        <View style={styles.sessionTitle}>
          <AppText variant="label" numberOfLines={2} style={styles.sessionAgent}>
            {session.user_agent || 'Unknown device'}
          </AppText>
          {session.current ? (
            <View style={[styles.currentBadge, { backgroundColor: theme.successSoft }]}>
              <AppText variant="caption" style={{ color: theme.success }}>
                This device
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText variant="caption" muted numberOfLines={2}>
          {session.ip_address || 'Unknown IP'} · active{' '}
          {formatDateTime(session.last_used_at ?? session.created_at)}
        </AppText>
      </View>
      {!session.current ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Revoke session ${session.user_agent || 'Unknown device'}`}
          disabled={pending}
          onPress={onRevoke}
          style={({ pressed }) => [
            styles.iconButton,
            { opacity: pending ? 0.45 : pressed ? 0.7 : 1 },
          ]}
        >
          {pending ? (
            <ActivityIndicator color={theme.danger} size="small" />
          ) : (
            <LogOut color={theme.danger} size={20} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function FormMessage({ message, success = false }: { message: string; success?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.message,
        { backgroundColor: success ? theme.successSoft : theme.dangerSoft },
      ]}
    >
      <AppText
        variant="caption"
        style={{ color: success ? theme.success : theme.danger }}
      >
        {message}
      </AppText>
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
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.xxl,
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
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  field: {
    gap: spacing.sm,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  textInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  bioInput: {
    minHeight: 104,
  },
  switchRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  switchCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
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
    minWidth: 0,
    minHeight: 46,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  sessionList: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sessionRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  deviceIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  sessionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  sessionAgent: {
    flexShrink: 1,
  },
  currentBadge: {
    minHeight: 24,
    borderRadius: radius.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  linkRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.xs,
  },
  dangerZone: {
    gap: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  confirmation: {
    gap: spacing.lg,
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
