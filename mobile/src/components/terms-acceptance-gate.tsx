import { ShieldCheck } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, View } from 'react-native';
// React Native's own SafeAreaView is a plain View on Android, which left the
// accept button sitting under the system navigation bar.
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { apiRequest } from '@/lib/api';
import { API_ORIGIN } from '@/lib/config';
import { getErrorMessage } from '@/lib/http';
import { useAuthStore } from '@/store/auth';
import type { User } from '@/types';

export function TermsAcceptanceGate() {
  const theme = useTheme();
  const t = useT();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visible = status === 'authenticated' && user?.terms_acceptance_required === true;

  const accept = async () => {
    setPending(true);
    setError(null);
    try {
      const updated = await apiRequest<User>('/auth/terms', {
        method: 'POST',
        body: { accepted_terms: true },
      });
      setUser(updated);
    } catch (acceptanceError) {
      setError(getErrorMessage(acceptanceError, t('legal.acceptanceError')));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => undefined}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <SafeAreaView style={styles.overlay}>
        <ScrollView
          bounces={false}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View
            accessibilityViewIsModal
            style={[
              styles.card,
              {
                backgroundColor: theme.background,
                borderColor: theme.border,
              },
            ]}
          >
            <View style={styles.headingRow}>
              <View style={[styles.icon, { backgroundColor: theme.primarySoft }]}>
                <ShieldCheck color={theme.primary} size={28} />
              </View>
              <View style={styles.headingCopy}>
                <AppText variant="section">{t('legal.acceptanceTitle')}</AppText>
                <AppText muted>{t('legal.acceptanceBody')}</AppText>
              </View>
            </View>

            <AppText muted>
              {t('legal.acceptanceReviewPre')}{' '}
              <AppText
                variant="label"
                accessibilityRole="link"
                style={{ color: theme.primary }}
                onPress={() => void Linking.openURL(`${API_ORIGIN}/terms`)}
              >
                {t('auth.termsOfUse')}
              </AppText>{' '}
              {t('auth.acceptTermsAnd')}{' '}
              <AppText
                variant="label"
                accessibilityRole="link"
                style={{ color: theme.primary }}
                onPress={() => void Linking.openURL(`${API_ORIGIN}/community-guidelines`)}
              >
                {t('auth.communityGuidelines')}
              </AppText>
              .
            </AppText>

            {error ? (
              <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                <AppText variant="caption" style={{ color: theme.danger }}>
                  {error}
                </AppText>
              </View>
            ) : null}

            <AppButton
              label={pending ? t('legal.accepting') : t('legal.acceptButton')}
              loading={pending}
              onPress={() => void accept()}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 520,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.xl,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  icon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headingCopy: {
    flex: 1,
    gap: spacing.sm,
  },
  error: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
});
