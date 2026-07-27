import { Minus, Plus, Star, X } from 'lucide-react-native';
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
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import {
  buildTrackingFeedbackPayload,
  MAX_REVIEW_LENGTH,
  type TrackingFeedbackPayload,
} from '@/lib/tracking-feedback';
import type { TrackingItem } from '@/types';

export function TrackingFeedbackSheet({
  item,
  pending,
  error,
  onClose,
  onSave,
}: {
  item: TrackingItem;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSave: (payload: TrackingFeedbackPayload) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const [rating, setRating] = useState<number | null>(item.rating);
  const [review, setReview] = useState(item.review ?? '');

  const changeRating = (change: number) => {
    setRating((current) => {
      const next = (current ?? 0) + change;
      return Math.min(10, Math.max(1, next));
    });
  };

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      onRequestClose={() => {
        if (!pending) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Pressable
          style={[styles.overlay, { backgroundColor: theme.overlay }]}
          onPress={() => {
            if (!pending) onClose();
          }}
        >
          <SafeAreaView
            edges={['bottom']}
            style={[styles.sheet, { backgroundColor: theme.elevated }]}
          >
            <Pressable onPress={(event) => event.stopPropagation()}>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.content}
              >
                <View style={styles.header}>
                  <View style={styles.headerCopy}>
                    <AppText variant="section">{t('feedback.title')}</AppText>
                    <AppText muted numberOfLines={2}>
                      {item.title}
                    </AppText>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('feedback.closeAria')}
                    disabled={pending}
                    hitSlop={8}
                    onPress={onClose}
                    style={styles.closeButton}
                  >
                    <X color={theme.mutedText} size={21} />
                  </Pressable>
                </View>

                <View style={styles.field}>
                  <AppText variant="label">{t('feedback.rating')}</AppText>
                  <View style={styles.stepper}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('feedback.decrease')}
                      disabled={pending || rating === null || rating <= 1}
                      onPress={() => changeRating(-1)}
                      style={[
                        styles.stepButton,
                        {
                          borderColor: theme.border,
                          opacity: rating === null || rating <= 1 ? 0.45 : 1,
                        },
                      ]}
                    >
                      <Minus color={theme.text} size={20} />
                    </Pressable>
                    <View
                      style={[styles.ratingValue, { backgroundColor: theme.warningSoft }]}
                    >
                      <Star
                        color={theme.warning}
                        fill={rating === null ? 'transparent' : theme.warning}
                        size={23}
                      />
                      <AppText variant="section" style={{ color: theme.warning }}>
                        {rating === null ? '-' : rating}
                      </AppText>
                      <AppText variant="caption" style={{ color: theme.warning }}>
                        /10
                      </AppText>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('feedback.increase')}
                      disabled={pending || rating === 10}
                      onPress={() => changeRating(1)}
                      style={[
                        styles.stepButton,
                        {
                          borderColor: theme.border,
                          opacity: rating === 10 ? 0.45 : 1,
                        },
                      ]}
                    >
                      <Plus color={theme.text} size={20} />
                    </Pressable>
                    <AppButton
                      label={t('feedback.clearRating')}
                      variant="secondary"
                      compact
                      disabled={rating === null || pending}
                      onPress={() => setRating(null)}
                    />
                  </View>
                </View>

                <View style={styles.field}>
                  <View style={styles.labelRow}>
                    <AppText variant="label">{t('feedback.review')}</AppText>
                    <AppText variant="caption" muted>
                      {review.length}/{MAX_REVIEW_LENGTH}
                    </AppText>
                  </View>
                  <TextInput
                    accessibilityLabel={t('feedback.review')}
                    value={review}
                    editable={!pending}
                    multiline
                    maxLength={MAX_REVIEW_LENGTH}
                    placeholder={t('feedback.reviewPlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    onChangeText={setReview}
                    style={[
                      styles.review,
                      {
                        color: theme.text,
                        borderColor: theme.border,
                        backgroundColor: theme.background,
                      },
                    ]}
                    textAlignVertical="top"
                  />
                </View>

                {error ? (
                  <View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
                    <AppText variant="caption" style={{ color: theme.danger }}>
                      {error}
                    </AppText>
                  </View>
                ) : null}

                <View style={styles.actions}>
                  <AppButton
                    label={t('common.cancel')}
                    variant="secondary"
                    disabled={pending}
                    onPress={onClose}
                    style={styles.action}
                  />
                  <AppButton
                    label={t('common.save')}
                    loading={pending}
                    onPress={() => onSave(buildTrackingFeedbackPayload(rating, review))}
                    style={styles.action}
                  />
                </View>
              </ScrollView>
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '92%',
    alignSelf: 'center',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.xl,
  },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    gap: spacing.sm,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  stepper: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepButton: {
    width: 46,
    height: 46,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingValue: {
    minWidth: 88,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radius.md,
  },
  review: {
    minHeight: 132,
    maxHeight: 240,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  action: {
    flex: 1,
  },
});
