import {
  CheckCircle2,
  Circle,
  CircleCheck,
  Flag,
  X,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
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
import { useReportContent } from '@/hooks/use-community-safety';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import {
  REPORT_REASONS,
  reportInputFromDraft,
  type ReportReason,
  type ReportTargetType,
} from '@/lib/community-safety';
import { getErrorMessage } from '@/lib/http';

export function ReportSheet({
  targetType,
  targetId,
  targetLabel,
  evidence,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string;
  targetLabel: string;
  /** What the reporter decrypted, for a message the server cannot read. */
  evidence?: { revealedPlaintext: string; frankingKey: string };
  onClose: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  const report = useReportContent();
  const [reason, setReason] = useState<ReportReason>('harassment');
  const [details, setDetails] = useState('');

  const submit = () => {
    report.mutate(reportInputFromDraft(targetType, targetId, reason, details, evidence));
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible
      onRequestClose={() => {
        if (!report.isPending) onClose();
      }}
    >
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.safeArea}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            <View style={styles.header}>
              <View style={styles.titleRow}>
                <View style={[styles.icon, { backgroundColor: theme.dangerSoft }]}>
                  <Flag color={theme.danger} size={22} />
                </View>
                <View style={styles.titleCopy}>
                  <AppText variant="section">{t('safety.reportTitle')}</AppText>
                  <AppText variant="caption" muted>
                    {t('safety.reportTarget', { target: targetLabel })}
                  </AppText>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('safety.closeReportAria')}
                disabled={report.isPending}
                onPress={onClose}
                style={[
                  styles.close,
                  {
                    borderColor: theme.border,
                    opacity: report.isPending ? 0.5 : 1,
                  },
                ]}
              >
                <X color={theme.text} size={20} />
              </Pressable>
            </View>

            {report.isSuccess ? (
              <View style={styles.success}>
                <CheckCircle2 color={theme.success} size={44} />
                <AppText variant="section">{t('safety.reportSent')}</AppText>
                <AppText muted style={styles.centered}>
                  {t('safety.reportSentHint')}
                </AppText>
                <View style={styles.fullWidth}>
                  <AppButton label={t('common.done')} onPress={onClose} />
                </View>
              </View>
            ) : (
              <>
                <View style={styles.field}>
                  <AppText variant="label">{t('safety.reason')}</AppText>
                  <View
                    style={[styles.reasonList, { borderColor: theme.border }]}
                    accessibilityRole="radiogroup"
                  >
                    {REPORT_REASONS.map((value, index) => {
                      const selected = reason === value;
                      return (
                        <Pressable
                          key={value}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: selected }}
                          onPress={() => setReason(value)}
                          style={[
                            styles.reasonRow,
                            index > 0 && {
                              borderTopColor: theme.border,
                              borderTopWidth: StyleSheet.hairlineWidth,
                            },
                            selected && { backgroundColor: theme.primarySoft },
                          ]}
                        >
                          {selected ? (
                            <CircleCheck color={theme.primary} size={20} />
                          ) : (
                            <Circle color={theme.mutedText} size={20} />
                          )}
                          <AppText style={styles.reasonLabel}>
                            {t(`safety.reason_${value}`)}
                          </AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.field}>
                  <View style={styles.detailsHeader}>
                    <AppText variant="label">{t('safety.detailsOptional')}</AppText>
                    <AppText variant="caption" muted>
                      {details.length}/1000
                    </AppText>
                  </View>
                  <TextInput
                    value={details}
                    onChangeText={setDetails}
                    multiline
                    maxLength={1000}
                    textAlignVertical="top"
                    placeholder={t('safety.detailsPlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    style={[
                      styles.details,
                      {
                        color: theme.text,
                        borderColor: theme.border,
                        backgroundColor: theme.elevated,
                      },
                    ]}
                  />
                </View>

                <AppText variant="caption" muted>
                  {t('safety.reportPrivacyHint')}
                </AppText>

                {report.error ? (
                  <AppText variant="caption" style={{ color: theme.danger }}>
                    {getErrorMessage(report.error, t('safety.reportError'))}
                  </AppText>
                ) : null}

                <View style={styles.actions}>
                  <View style={styles.action}>
                    <AppButton
                      label={t('common.cancel')}
                      variant="secondary"
                      disabled={report.isPending}
                      onPress={onClose}
                    />
                  </View>
                  <View style={styles.action}>
                    <AppButton
                      label={t('safety.submitReport')}
                      variant="danger"
                      loading={report.isPending}
                      onPress={submit}
                    />
                  </View>
                </View>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  titleRow: {
    minWidth: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  titleCopy: { minWidth: 0, flex: 1, gap: spacing.xs },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: { gap: spacing.sm },
  reasonList: {
    overflow: 'hidden',
    borderWidth: 1,
    borderRadius: radius.md,
  },
  reasonRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  reasonLabel: { flex: 1 },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  details: {
    minHeight: 128,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 15,
  },
  actions: { flexDirection: 'row', gap: spacing.md },
  action: { flex: 1 },
  success: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  centered: { textAlign: 'center' },
  fullWidth: { width: '100%', marginTop: spacing.md },
});
