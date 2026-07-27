import { Redirect, router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { useSensitiveScreen } from '@/hooks/use-sensitive-screen';
import {
  AlertTriangle,
  Bell,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Globe2,
  HelpCircle,
  KeyRound,
  Laptop2,
  LogOut,
  Mail,
  MailWarning,
  RefreshCw,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  UploadCloud,
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
import { CalendarFeedSection } from '@/components/calendar-feed-section';
import { LanguageSection } from '@/components/language-section';
import { SegmentedControl } from '@/components/segmented-control';
import { UserAvatar } from '@/components/user-avatar';
import { radius, spacing } from '@/constants/theme';
import {
  useAccountSessions,
  useChangeAccountPassword,
  useDeleteAccountAvatar,
  useDisableTwoFactor,
  useEnableTwoFactor,
  useLogoutAllAccountSessions,
  useRequestAccountEmailChange,
  useResendEmailVerification,
  useRevokeAccountSession,
  useSetupTwoFactor,
  useUpdateAccountProfile,
  useUploadAccountAvatar,
} from '@/hooks/use-account';
import {
  useCalendarPreferences,
  useUpdateCalendarPreferences,
} from '@/hooks/use-calendar';
import { useReleaseNotifications } from '@/hooks/use-release-notifications';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import {
  deleteAccountSession,
  MAX_PROFILE_BIO_LENGTH,
  validatePasswordChange,
  validateProfileDraft,
} from '@/lib/account';
import { exportAndShareAccountData } from '@/lib/data-export';
import { formatDateTime, getFormatLocaleTag } from '@/lib/format';
import { getErrorMessage } from '@/lib/http';
import { clearOfflineQueryCache } from '@/lib/query-persistence';
import { validateSecondFactorInput } from '@/lib/two-factor';
import { useAuthStore } from '@/store/auth';
import type { AccountSession } from '@/types';

const COUNTRY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'RO', label: 'RO' },
  { value: 'US', label: 'US' },
  { value: 'GB', label: 'GB' },
  { value: 'DE', label: 'DE' },
  { value: 'FR', label: 'FR' },
  { value: 'IT', label: 'IT' },
  { value: 'ES', label: 'ES' },
  { value: 'NL', label: 'NL' },
  { value: 'SE', label: 'SE' },
  { value: 'PL', label: 'PL' },
  { value: 'CA', label: 'CA' },
  { value: 'AU', label: 'AU' },
  { value: 'JP', label: 'JP' },
  { value: 'KR', label: 'KR' },
];

/** Localized country name for the active UI language, falling back to the code. */
function regionName(code: string): string {
  try {
    return new Intl.DisplayNames([getFormatLocaleTag()], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export default function SettingsScreen() {
  const theme = useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const updateProfile = useUpdateAccountProfile();
  const uploadAvatar = useUploadAccountAvatar();
  const deleteAvatar = useDeleteAccountAvatar();
  const preferences = useCalendarPreferences(status === 'authenticated');
  const updatePreferences = useUpdateCalendarPreferences();
  const sessions = useAccountSessions(status === 'authenticated');
  const revokeSession = useRevokeAccountSession();
  const logoutAllSessions = useLogoutAllAccountSessions();
  const changePassword = useChangeAccountPassword();
  const requestEmailChange = useRequestAccountEmailChange();
  const resendVerification = useResendEmailVerification();
  const setupTwoFactor = useSetupTwoFactor();
  const enableTwoFactor = useEnableTwoFactor();
  const disableTwoFactor = useDisableTwoFactor();
  const releaseAlerts = useReleaseNotifications(
    user?.id ?? '',
    status === 'authenticated',
  );

  const [username, setUsername] = useState(user?.username ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [isPublic, setIsPublic] = useState(user?.is_public ?? false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const [emailPassword, setEmailPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [twoFactorSetupPassword, setTwoFactorSetupPassword] = useState('');
  const [twoFactorDisablePassword, setTwoFactorDisablePassword] = useState('');
  const [twoFactorPasswordVisible, setTwoFactorPasswordVisible] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // The setup key can enroll another authenticator, while recovery codes can
  // bypass 2FA entirely. Guard and conceal both kinds of secret.
  const secretsConcealed = useSensitiveScreen(
    recoveryCodes !== null || setupTwoFactor.data !== undefined,
  );

  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [showDeletionPassword, setShowDeletionPassword] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [exportConfirming, setExportConfirming] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordVisible, setExportPasswordVisible] = useState(false);
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportShared, setExportShared] = useState(false);

  if (status !== 'authenticated' || !user) return <Redirect href="/" />;

  const profileDirty =
    username.trim() !== user.username ||
    bio.trim() !== (user.bio ?? '') ||
    isPublic !== user.is_public;
  const countryCode =
    (updatePreferences.isPending ? updatePreferences.variables : undefined) ??
    preferences.data?.country_code ??
    'RO';
  const countryName = regionName(countryCode);

  const saveProfile = async () => {
    const validationError = validateProfileDraft(t, username, bio);
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
      setProfileError(getErrorMessage(error, t('settings.profileUpdateError')));
    }
  };

  const chooseAvatar = async () => {
    setAvatarError(null);
    try {
      await uploadAvatar.mutateAsync();
    } catch (error) {
      setAvatarError(getErrorMessage(error, t('settings.avatarUpdateError')));
    }
  };

  const confirmAvatarDeletion = () => {
    setAvatarError(null);
    Alert.alert(t('settings.removeAvatarConfirmTitle'), t('settings.removeAvatarConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => {
          void deleteAvatar.mutateAsync().catch((error) => {
            setAvatarError(getErrorMessage(error, t('settings.avatarRemoveError')));
          });
        },
      },
    ]);
  };

  const submitEmailChange = async () => {
    const address = newEmail.trim();
    if (!address.includes('@') || address.length > 254) {
      setEmailError(t('auth.invalidEmail'));
      return;
    }
    if (!emailPassword) {
      setEmailError(t('settings.enterCurrentPassword'));
      return;
    }
    setEmailError(null);
    try {
      await requestEmailChange.mutateAsync({
        currentPassword: emailPassword,
        newEmail: address,
      });
      // The session is untouched on purpose — the address has not moved yet.
      setEmailSentTo(address);
      setEmailPassword('');
      setNewEmail('');
    } catch (error) {
      setEmailError(getErrorMessage(error, t('settings.emailChangeError')));
    }
  };

  const submitPasswordChange = async () => {
    const validationError = validatePasswordChange(
      t,
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
      Alert.alert(t('settings.passwordUpdatedTitle'), t('settings.passwordUpdatedMessage'));
    } catch (error) {
      setPasswordError(getErrorMessage(error, t('settings.passwordChangeError')));
    }
  };

  const confirmLogoutAll = () => {
    setSessionsError(null);
    Alert.alert(
      t('settings.signOutConfirmTitle'),
      t('settings.signOutConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.signOutEverywhere'),
          style: 'destructive',
          onPress: () => {
            void logoutAllSessions
              .mutateAsync()
              .then(() => router.replace('/'))
              .catch((error) => {
                setSessionsError(getErrorMessage(error, t('settings.signOutAllError')));
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
      setDeletionError(getErrorMessage(error, t('settings.deleteAccountError')));
    } finally {
      setDeletionPending(false);
    }
  };

  const confirmDeletion = () => {
    setDeletionError(null);
    if (!deletionPassword) {
      setDeletionError(t('settings.enterCurrentPassword'));
      return;
    }
    if (deletionPassword.length > 128) {
      setDeletionError(t('settings.passwordMaxLength'));
      return;
    }
    Alert.alert(
      t('settings.deleteConfirmTitle'),
      t('settings.deleteConfirmMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.deleteAccount'),
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

  const confirmCacheClear = () => {
    Alert.alert(t('settings.clearOfflineConfirmTitle'), t('settings.clearOfflineConfirmMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.clearData'),
        style: 'destructive',
        onPress: () => {
          setCacheClearing(true);
          setCacheCleared(false);
          void clearOfflineQueryCache(queryClient)
            .then(() => setCacheCleared(true))
            .catch(() =>
              Alert.alert(t('settings.clearDataErrorTitle'), t('settings.clearDataErrorMessage')),
            )
            .finally(() => setCacheClearing(false));
        },
      },
    ]);
  };

  const exportData = async () => {
    if (!exportPassword || exportPassword.length > 128) {
      setExportError(t('settings.enterCurrentPassword'));
      return;
    }
    setExportPending(true);
    setExportError(null);
    setExportShared(false);
    try {
      await exportAndShareAccountData(exportPassword);
      setExportPassword('');
      setExportPasswordVisible(false);
      setExportConfirming(false);
      setExportShared(true);
    } catch (error) {
      setExportError(getErrorMessage(error, t('settings.exportError')));
    } finally {
      setExportPending(false);
    }
  };

  const cancelExport = () => {
    if (exportPending) return;
    setExportConfirming(false);
    setExportPassword('');
    setExportPasswordVisible(false);
    setExportError(null);
  };

  const startTwoFactorSetup = async () => {
    setTwoFactorError(null);
    setRecoveryCodes(null);
    if (user.email_verified === false) {
      setTwoFactorError(t('settings.twoFactorEmailHint'));
      return;
    }
    if (!twoFactorSetupPassword || twoFactorSetupPassword.length > 128) {
      setTwoFactorError(t('settings.enterCurrentPassword'));
      return;
    }
    try {
      await setupTwoFactor.mutateAsync(twoFactorSetupPassword);
      setTwoFactorSetupPassword('');
      setTwoFactorCode('');
    } catch (error) {
      setTwoFactorError(getErrorMessage(error, t('settings.twoFactorStartError')));
    }
  };

  const confirmTwoFactorSetup = async () => {
    const validationError = validateSecondFactorInput(t, 'authenticator', twoFactorCode);
    if (validationError) {
      setTwoFactorError(validationError);
      return;
    }
    setTwoFactorError(null);
    try {
      const result = await enableTwoFactor.mutateAsync(twoFactorCode);
      setRecoveryCodes(result.recovery_codes);
      setTwoFactorCode('');
      setupTwoFactor.reset();
    } catch (error) {
      setTwoFactorError(getErrorMessage(error, t('settings.twoFactorEnableError')));
    }
  };

  const cancelTwoFactorSetup = () => {
    setupTwoFactor.reset();
    enableTwoFactor.reset();
    setTwoFactorCode('');
    setTwoFactorError(null);
  };

  const openAuthenticator = async () => {
    if (!setupTwoFactor.data) return;
    try {
      await Linking.openURL(setupTwoFactor.data.otpauth_uri);
    } catch {
      setTwoFactorError(t('settings.noAuthenticatorApp'));
    }
  };

  const confirmDisableTwoFactor = async () => {
    setTwoFactorError(null);
    if (!twoFactorDisablePassword || twoFactorDisablePassword.length > 128) {
      setTwoFactorError(t('settings.enterCurrentPassword'));
      return;
    }
    try {
      await disableTwoFactor.mutateAsync(twoFactorDisablePassword);
      setTwoFactorDisablePassword('');
      setRecoveryCodes(null);
    } catch (error) {
      setTwoFactorError(getErrorMessage(error, t('settings.twoFactorDisableError')));
    }
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
                <AppText variant="section">{t('settings.profilePrivacy')}</AppText>
                <AppText variant="caption" muted numberOfLines={2}>
                  {user.email}
                </AppText>
              </View>
            </View>

            <View style={styles.avatarEditor}>
              <UserAvatar uri={user.avatar_url} size={80} />
              <View style={styles.avatarActions}>
                <AppButton
                  label={user.avatar_url ? t('settings.changePicture') : t('settings.choosePicture')}
                  variant="secondary"
                  compact
                  loading={uploadAvatar.isPending}
                  disabled={deleteAvatar.isPending}
                  onPress={() => void chooseAvatar()}
                />
                {user.avatar_url ? (
                  <AppButton
                    label={t('settings.removePicture')}
                    variant="danger"
                    compact
                    loading={deleteAvatar.isPending}
                    disabled={uploadAvatar.isPending}
                    onPress={confirmAvatarDeletion}
                  />
                ) : null}
                <AppText variant="caption" muted>
                  {t('settings.avatarHint')}
                </AppText>
              </View>
            </View>
            {avatarError ? <FormMessage message={avatarError} /> : null}

            <View style={styles.field}>
              <AppText variant="label">{t('auth.username')}</AppText>
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
                placeholder={t('auth.username')}
                placeholderTextColor={theme.mutedText}
                style={[
                  styles.textInput,
                  { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated },
                ]}
              />
            </View>

            <View style={styles.field}>
              <View style={styles.fieldLabelRow}>
                <AppText variant="label">{t('settings.bio')}</AppText>
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
                placeholder={t('settings.bioPlaceholder')}
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
                <AppText variant="label">{t('settings.publicProfile')}</AppText>
                <AppText variant="caption" muted>
                  {user.email_verified === false && !isPublic
                    ? t('settings.publicEmailHint')
                    : t('settings.publicHint')}
                </AppText>
              </View>
              <Switch
                accessibilityLabel={t('settings.publicProfile')}
                value={isPublic}
                disabled={
                  updateProfile.isPending || (user.email_verified === false && !isPublic)
                }
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
            {profileSaved ? <FormMessage message={t('settings.profileUpdated')} success /> : null}
            <AppButton
              label={t('settings.saveProfile')}
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
                <AppText variant="section">{t('settings.releaseRegion')}</AppText>
                <AppText variant="caption" muted>
                  {t('settings.regionValue', { name: countryName, code: countryCode })}
                </AppText>
              </View>
            </View>
            <AppText muted>{t('settings.regionHint')}</AppText>
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
              <FormMessage message={t('settings.regionLoadError')} />
            ) : null}
            {updatePreferences.error ? (
              <FormMessage
                message={getErrorMessage(updatePreferences.error, t('settings.regionUpdateError'))}
              />
            ) : null}
          </View>

          <LanguageSection />

          <CalendarFeedSection />

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <Bell color={theme.primary} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">{t('settings.releaseAlerts')}</AppText>
                <AppText variant="caption" muted>
                  {t('settings.releaseAlertsHint')}
                </AppText>
              </View>
            </View>
            <View style={[styles.switchRow, { borderColor: theme.border }]}>
              <View style={styles.switchCopy}>
                <AppText variant="label">
                  {releaseAlerts.state.enabled ? t('settings.on') : t('settings.off')}
                </AppText>
                <AppText variant="caption" muted>
                  {releaseAlerts.state.permission === 'denied'
                    ? t('settings.permBlocked')
                    : releaseAlerts.state.permission === 'unavailable' ||
                        releaseAlerts.state.permission === 'unsupported'
                      ? t('settings.permUnavailable')
                      : releaseAlerts.state.pending
                        ? t('settings.permPending')
                        : t('settings.permReady')}
                </AppText>
              </View>
              {releaseAlerts.isLoading ? (
                <ActivityIndicator color={theme.primary} />
              ) : (
                <Switch
                  accessibilityLabel={t('settings.releaseAlerts')}
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
                label={t('settings.openSystemSettings')}
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
                  <AppText variant="section">{t('settings.confirmEmail')}</AppText>
                  <AppText variant="caption" muted numberOfLines={2}>
                    {t('settings.confirmEmailHint', { email: user.email })}
                  </AppText>
                </View>
              </View>
              {resendVerification.isSuccess ? (
                <FormMessage message={t('settings.confirmationLinkSent')} success />
              ) : null}
              {resendVerification.isError ? (
                <FormMessage
                  message={getErrorMessage(resendVerification.error, t('settings.linkSendError'))}
                />
              ) : null}
              <AppButton
                label={resendVerification.isSuccess ? t('settings.linkSent') : t('settings.resendConfirmation')}
                icon={<MailWarning color="#FFFFFF" size={18} />}
                loading={resendVerification.isPending}
                disabled={resendVerification.isSuccess}
                onPress={() => resendVerification.mutate()}
              />
            </View>
          ) : null}

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <ShieldCheck color={theme.primary} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">{t('settings.twoFactor')}</AppText>
                <AppText variant="caption" muted>
                  {t('settings.twoFactorHint')}
                </AppText>
              </View>
            </View>

            {recoveryCodes ? (
              <View style={styles.confirmation}>
                <View style={[styles.notice, { borderColor: theme.warning }]}>
                  <AlertTriangle color={theme.warning} size={18} />
                  <AppText variant="caption" style={styles.noticeCopy}>
                    {t('settings.recoveryCodesWarning')}
                  </AppText>
                </View>
                <View
                  accessibilityLabel={t('settings.recoveryCodesAria')}
                  style={[
                    styles.recoveryCodeList,
                    { borderColor: theme.border, backgroundColor: theme.elevated },
                  ]}
                >
                  {secretsConcealed ? (
                    <AppText muted style={styles.monospace}>
                      {t('settings.hiddenBackground')}
                    </AppText>
                  ) : (
                    recoveryCodes.map((code) => (
                      <AppText key={code} selectable style={styles.monospace}>
                        {code}
                      </AppText>
                    ))
                  )}
                </View>
                <AppButton
                  label={t('settings.savedCodes')}
                  icon={<ShieldCheck color="#FFFFFF" size={18} />}
                  onPress={() => setRecoveryCodes(null)}
                />
              </View>
            ) : user.two_factor_enabled ? (
              <View style={styles.confirmation}>
                <FormMessage message={t('settings.twoFactorOn')} success />
                <PasswordField
                  label={t('settings.passwordToDisable')}
                  value={twoFactorDisablePassword}
                  visible={twoFactorPasswordVisible}
                  autoComplete="current-password"
                  onChange={(value) => {
                    setTwoFactorDisablePassword(value);
                    setTwoFactorError(null);
                  }}
                  onToggleVisibility={() =>
                    setTwoFactorPasswordVisible((visible) => !visible)
                  }
                  onSubmit={() => void confirmDisableTwoFactor()}
                />
                {twoFactorError ? <FormMessage message={twoFactorError} /> : null}
                <AppButton
                  label={t('settings.disableTwoFactor')}
                  variant="danger"
                  loading={disableTwoFactor.isPending}
                  onPress={() => void confirmDisableTwoFactor()}
                />
              </View>
            ) : setupTwoFactor.data ? (
              <View style={styles.confirmation}>
                <AppButton
                  label={t('settings.openAuthenticator')}
                  icon={<ExternalLink color={theme.text} size={18} />}
                  variant="secondary"
                  onPress={() => void openAuthenticator()}
                />
                <View style={styles.field}>
                  <AppText variant="label">{t('settings.manualKey')}</AppText>
                  <View
                    style={[
                      styles.secretBox,
                      { borderColor: theme.border, backgroundColor: theme.elevated },
                    ]}
                  >
                    {secretsConcealed ? (
                      <AppText muted style={styles.monospace}>
                        Hidden while the app is in the background.
                      </AppText>
                    ) : (
                      <AppText selectable style={styles.monospace}>
                        {setupTwoFactor.data.secret}
                      </AppText>
                    )}
                  </View>
                </View>
                <View style={styles.field}>
                  <AppText variant="label">{t('settings.sixDigitCode')}</AppText>
                  <TextInput
                    value={twoFactorCode}
                    onChangeText={(value) => {
                      setTwoFactorCode(value);
                      setTwoFactorError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    keyboardType="number-pad"
                    maxLength={6}
                    placeholder={t('auth.authCodePlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    onSubmitEditing={() => void confirmTwoFactorSetup()}
                    style={[
                      styles.textInput,
                      {
                        color: theme.text,
                        borderColor: theme.border,
                        backgroundColor: theme.elevated,
                      },
                    ]}
                  />
                </View>
                {twoFactorError ? <FormMessage message={twoFactorError} /> : null}
                <View style={styles.actions}>
                  <View style={styles.action}>
                    <AppButton
                      label={t('settings.confirmEnable')}
                      loading={enableTwoFactor.isPending}
                      onPress={() => void confirmTwoFactorSetup()}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label={t('common.cancel')}
                      variant="secondary"
                      disabled={enableTwoFactor.isPending}
                      onPress={cancelTwoFactorSetup}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.confirmation}>
                <PasswordField
                  label={t('settings.passwordToSetup')}
                  value={twoFactorSetupPassword}
                  visible={twoFactorPasswordVisible}
                  autoComplete="current-password"
                  onChange={(value) => {
                    setTwoFactorSetupPassword(value);
                    setTwoFactorError(null);
                  }}
                  onToggleVisibility={() =>
                    setTwoFactorPasswordVisible((visible) => !visible)
                  }
                  onSubmit={() => void startTwoFactorSetup()}
                />
                {user.email_verified === false ? (
                  <FormMessage message={t('settings.twoFactorEmailHint')} />
                ) : twoFactorError ? (
                  <FormMessage message={twoFactorError} />
                ) : null}
                <AppButton
                  label={t('settings.setupTwoFactor')}
                  icon={<ShieldCheck color="#FFFFFF" size={18} />}
                  loading={setupTwoFactor.isPending}
                  disabled={user.email_verified === false}
                  onPress={() => void startTwoFactorSetup()}
                />
              </View>
            )}
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <Mail color={theme.info} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">{t('settings.changeEmail')}</AppText>
                <AppText variant="caption" muted>
                  {t('settings.emailSignsIn', { email: user.email })}
                </AppText>
              </View>
            </View>
            {emailSentTo ? (
              <FormMessage
                success
                message={t('settings.emailChangeSent', {
                  address: emailSentTo,
                  email: user.email,
                })}
              />
            ) : (
              <>
                <View style={styles.field}>
                  <AppText variant="label">{t('settings.newEmail')}</AppText>
                  <TextInput
                    value={newEmail}
                    onChangeText={(value) => {
                      setNewEmail(value);
                      setEmailError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    maxLength={254}
                    placeholder={t('auth.emailPlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    style={[
                      styles.textInput,
                      { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated },
                    ]}
                  />
                </View>
                <PasswordField
                  label={t('settings.currentPassword')}
                  value={emailPassword}
                  visible={showPasswords}
                  autoComplete="current-password"
                  onChange={(value) => {
                    setEmailPassword(value);
                    setEmailError(null);
                  }}
                  onToggleVisibility={() => setShowPasswords((visible) => !visible)}
                  onSubmit={() => void submitEmailChange()}
                />
                {emailError ? <FormMessage message={emailError} /> : null}
                <AppButton
                  label={t('settings.sendConfirmationLink')}
                  icon={<Mail color="#FFFFFF" size={18} />}
                  loading={requestEmailChange.isPending}
                  onPress={() => void submitEmailChange()}
                />
              </>
            )}
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <KeyRound color={theme.warning} size={20} />
              <View style={styles.headingCopy}>
                <AppText variant="section">{t('settings.changePassword')}</AppText>
                <AppText variant="caption" muted>
                  {t('settings.changePasswordHint')}
                </AppText>
              </View>
            </View>
            <PasswordField
              label={t('settings.currentPassword')}
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
              label={t('auth.newPassword')}
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
              label={t('auth.confirmNewPassword')}
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
              label={t('settings.updatePassword')}
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
                  <AppText variant="section">{t('settings.activeSessions')}</AppText>
                  <AppText variant="caption" muted>
                    {t('settings.activeSessionsHint')}
                  </AppText>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('settings.refreshSessions')}
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
                message={getErrorMessage(sessions.error, t('settings.sessionsLoadError'))}
              />
            ) : sessions.data?.length === 0 ? (
              <AppText muted>{t('settings.noSessions')}</AppText>
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
                            getErrorMessage(error, t('settings.sessionRevokeError')),
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
              label={t('settings.signOutEverywhere')}
              icon={<LogOut color="#FFFFFF" size={18} />}
              variant="danger"
              loading={logoutAllSessions.isPending}
              onPress={confirmLogoutAll}
            />
          </View>

          <View style={[styles.section, { borderBottomColor: theme.border }]}>
            <View style={styles.sectionHeading}>
              <ShieldCheck color={theme.info} size={20} />
              <AppText variant="section">{t('settings.privacyData')}</AppText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('importTvtime.title')}
              onPress={() => router.push('/import-tvtime')}
              style={({ pressed }) => [
                styles.linkRow,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <View style={styles.linkCopy}>
                <UploadCloud color={theme.primary} size={18} />
                <View style={styles.headingCopy}>
                  <AppText variant="label">{t('importTvtime.title')}</AppText>
                  <AppText variant="caption" muted>
                    {t('settings.importHint')}
                  </AppText>
                </View>
              </View>
              <ExternalLink color={theme.mutedText} size={18} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('settings.exportAria')}
              onPress={() => {
                setExportShared(false);
                setExportError(null);
                setExportConfirming(true);
              }}
              style={({ pressed }) => [
                styles.linkRow,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <View style={styles.linkCopy}>
                <Download color={theme.success} size={18} />
                <View style={styles.headingCopy}>
                  <AppText variant="label">{t('settings.exportData')}</AppText>
                  <AppText variant="caption" muted>
                    {t('settings.exportHint')}
                  </AppText>
                </View>
              </View>
              <ExternalLink color={theme.mutedText} size={18} />
            </Pressable>
            {exportConfirming ? (
              <View style={styles.confirmation}>
                <PasswordField
                  label={t('settings.passwordToExport')}
                  value={exportPassword}
                  visible={exportPasswordVisible}
                  autoComplete="current-password"
                  onChange={(value) => {
                    setExportPassword(value);
                    setExportError(null);
                  }}
                  onToggleVisibility={() =>
                    setExportPasswordVisible((visible) => !visible)
                  }
                  onSubmit={() => void exportData()}
                />
                <AppText variant="caption" muted>
                  {t('settings.exportFileHint')}
                </AppText>
                {exportError ? <FormMessage message={exportError} /> : null}
                <View style={styles.actions}>
                  <View style={styles.action}>
                    <AppButton
                      label={t('settings.createExport')}
                      icon={<Download color="#FFFFFF" size={18} />}
                      loading={exportPending}
                      onPress={() => void exportData()}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label={t('common.cancel')}
                      variant="secondary"
                      disabled={exportPending}
                      onPress={cancelExport}
                    />
                  </View>
                </View>
              </View>
            ) : null}
            {exportShared ? <FormMessage message={t('settings.exportReady')} success /> : null}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('settings.privacyPolicyAria')}
              onPress={() => void Linking.openURL('https://vazute.micutu.com/privacy')}
              style={({ pressed }) => [
                styles.linkRow,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <AppText variant="label">{t('settings.privacyPolicy')}</AppText>
              <ExternalLink color={theme.mutedText} size={18} />
            </Pressable>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('settings.supportAria')}
              onPress={() =>
                void Linking.openURL(
                  'mailto:postmaster@micutu.com?subject=Vazute%20mobile%20support',
                )
              }
              style={({ pressed }) => [
                styles.linkRow,
                { borderColor: theme.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <View style={styles.linkCopy}>
                <HelpCircle color={theme.info} size={18} />
                <View style={styles.headingCopy}>
                  <AppText variant="label">{t('settings.helpSupport')}</AppText>
                  <AppText variant="caption" muted>
                    postmaster@micutu.com
                  </AppText>
                </View>
              </View>
              <ExternalLink color={theme.mutedText} size={18} />
            </Pressable>
            {cacheCleared ? <FormMessage message={t('settings.offlineCleared')} success /> : null}
            <AppButton
              label={t('settings.clearOffline')}
              icon={<Trash2 color={theme.text} size={18} />}
              variant="secondary"
              loading={cacheClearing}
              onPress={confirmCacheClear}
            />
          </View>

          <View style={[styles.dangerZone, { borderColor: theme.danger }]}>
            <View style={styles.sectionHeading}>
              <AlertTriangle color={theme.danger} size={20} />
              <AppText variant="section" style={{ color: theme.danger }}>
                {t('settings.deleteAccount')}
              </AppText>
            </View>
            <AppText muted>{t('settings.deleteAccountHint')}</AppText>

            {!confirmingDeletion ? (
              <AppButton
                label={t('settings.deleteMyAccount')}
                icon={<Trash2 color="#FFFFFF" size={18} />}
                variant="danger"
                onPress={() => setConfirmingDeletion(true)}
              />
            ) : (
              <View style={styles.confirmation}>
                <PasswordField
                  label={t('settings.currentPassword')}
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
                      label={t('settings.permanentlyDelete')}
                      icon={<Trash2 color="#FFFFFF" size={18} />}
                      variant="danger"
                      loading={deletionPending}
                      onPress={confirmDeletion}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label={t('common.cancel')}
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
          onChangeText={onChange}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          textContentType={autoComplete === 'current-password' ? 'password' : 'newPassword'}
          maxLength={128}
          placeholder={t('auth.passwordPlaceholder')}
          placeholderTextColor={theme.mutedText}
          style={[styles.passwordInput, { color: theme.text }]}
          onSubmitEditing={onSubmit}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? t('auth.hidePasswords') : t('auth.showPasswords')}
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
  const t = useT();
  const looksMobile = /android|ios|mobile|okhttp/i.test(session.user_agent ?? '');
  const DeviceIcon = looksMobile ? Smartphone : Laptop2;
  const deviceName = session.user_agent || t('settings.unknownDevice');
  return (
    <View style={[styles.sessionRow, { borderBottomColor: theme.border }]}>
      <View style={[styles.deviceIcon, { backgroundColor: theme.surface }]}>
        <DeviceIcon color={theme.mutedText} size={20} />
      </View>
      <View style={styles.sessionCopy}>
        <View style={styles.sessionTitle}>
          <AppText variant="label" numberOfLines={2} style={styles.sessionAgent}>
            {deviceName}
          </AppText>
          {session.current ? (
            <View style={[styles.currentBadge, { backgroundColor: theme.successSoft }]}>
              <AppText variant="caption" style={{ color: theme.success }}>
                {t('settings.thisDevice')}
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText variant="caption" muted numberOfLines={2}>
          {t('settings.sessionMeta', {
            ip: session.ip_address || t('settings.unknownIp'),
            when: formatDateTime(session.last_used_at ?? session.created_at),
          })}
        </AppText>
      </View>
      {!session.current ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('settings.revokeSessionAria', { agent: deviceName })}
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
  avatarEditor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  avatarActions: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    gap: spacing.sm,
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
  notice: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeCopy: {
    flex: 1,
    minWidth: 0,
  },
  secretBox: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  recoveryCodeList: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  monospace: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 14,
    lineHeight: 20,
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
  linkCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
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
