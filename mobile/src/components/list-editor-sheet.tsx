import { X } from 'lucide-react-native';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
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
import { radius, spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import {
  LIST_DESCRIPTION_MAX_LENGTH,
  LIST_NAME_MAX_LENGTH,
  listInputFromDraft,
  type ListDraftError,
  type ListInput,
} from '@/lib/lists';

interface EditableList {
  name: string;
  description: string | null;
  is_public: boolean;
}

type Translate = ReturnType<typeof useT>;

/** Resolves a validation failure to a localized message. */
function describeDraftError(t: Translate, error: ListDraftError): string {
  switch (error.code) {
    case 'nameBlank':
      return t('listEditor.errorNameBlank');
    case 'nameTooLong':
      return t('listEditor.errorNameTooLong', { max: error.max });
    case 'descriptionTooLong':
      return t('listEditor.errorDescriptionTooLong', { max: error.max });
  }
}

export function ListEditorSheet({
  list,
  pending,
  error,
  onClose,
  onSave,
}: {
  list?: EditableList;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSave: (input: ListInput) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [isPublic, setIsPublic] = useState(list?.is_public ?? false);
  const [validationError, setValidationError] = useState<ListDraftError | null>(null);

  const submit = () => {
    const result = listInputFromDraft(name, description, isPublic);
    if (!result.input) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    onSave(result.input);
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
        style={[styles.overlay, { backgroundColor: theme.overlay }]}
      >
        <Pressable
          style={styles.overlayPressable}
          onPress={() => {
            if (!pending) onClose();
          }}
        >
          <SafeAreaView
            edges={['bottom']}
            style={[styles.sheet, { backgroundColor: theme.elevated }]}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.sheetContent}
            >
              <Pressable onPress={(event) => event.stopPropagation()}>
              <View style={styles.header}>
                <View style={styles.headerCopy}>
                  <AppText variant="section">
                    {list ? t('listEditor.editTitle') : t('listEditor.createTitle')}
                  </AppText>
                  <AppText variant="caption" muted>
                    {t('listEditor.subtitle')}
                  </AppText>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('listEditor.closeAria')}
                  disabled={pending}
                  onPress={onClose}
                  style={[styles.iconButton, { borderColor: theme.border }]}
                >
                  <X color={theme.mutedText} size={20} />
                </Pressable>
              </View>

              <View style={styles.form}>
                <View style={styles.fieldGroup}>
                  <AppText variant="label">{t('listEditor.name')}</AppText>
                  <TextInput
                    accessibilityLabel={t('listEditor.name')}
                    autoFocus
                    value={name}
                    onChangeText={(value) => {
                      setName(value);
                      setValidationError(null);
                    }}
                    maxLength={LIST_NAME_MAX_LENGTH}
                    placeholder={t('listEditor.namePlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    returnKeyType="next"
                    style={[
                      styles.input,
                      {
                        color: theme.text,
                        backgroundColor: theme.surface,
                        borderColor: validationError ? theme.danger : theme.border,
                      },
                    ]}
                  />
                </View>

                <View style={styles.fieldGroup}>
                  <AppText variant="label">{t('listEditor.description')}</AppText>
                  <TextInput
                    accessibilityLabel={t('listEditor.description')}
                    multiline
                    value={description}
                    onChangeText={setDescription}
                    maxLength={LIST_DESCRIPTION_MAX_LENGTH}
                    placeholder={t('listEditor.descriptionPlaceholder')}
                    placeholderTextColor={theme.mutedText}
                    textAlignVertical="top"
                    style={[
                      styles.input,
                      styles.description,
                      {
                        color: theme.text,
                        backgroundColor: theme.surface,
                        borderColor: theme.border,
                      },
                    ]}
                  />
                  <AppText variant="caption" muted style={styles.counter}>
                    {description.length}/{LIST_DESCRIPTION_MAX_LENGTH}
                  </AppText>
                </View>

                <View
                  style={[
                    styles.privacyRow,
                    { backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                >
                  <View style={styles.privacyCopy}>
                    <AppText variant="label">{t('listEditor.publicList')}</AppText>
                    <AppText variant="caption" muted>
                      {t('listEditor.publicHint')}
                    </AppText>
                  </View>
                  <Switch
                    accessibilityLabel={t('listEditor.publicList')}
                    value={isPublic}
                    onValueChange={setIsPublic}
                    trackColor={{ false: theme.border, true: theme.primarySoft }}
                    thumbColor={isPublic ? theme.primary : theme.mutedText}
                  />
                </View>

                {validationError || error ? (
                  <AppText variant="caption" style={{ color: theme.danger }}>
                    {validationError
                      ? describeDraftError(t, validationError)
                      : getErrorMessage(error, t('listEditor.saveError'))}
                  </AppText>
                ) : null}
              </View>

              <View style={styles.actions}>
                <AppButton
                  label={t('common.cancel')}
                  variant="secondary"
                  disabled={pending}
                  onPress={onClose}
                  style={styles.action}
                />
                <AppButton
                  label={list ? t('listEditor.saveChanges') : t('listEditor.createTitle')}
                  loading={pending}
                  onPress={submit}
                  style={styles.action}
                />
              </View>
              </Pressable>
            </ScrollView>
          </SafeAreaView>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  overlayPressable: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    width: '100%',
    maxHeight: '92%',
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetContent: {
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  form: {
    gap: spacing.lg,
    paddingTop: spacing.xl,
  },
  fieldGroup: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 15,
  },
  description: {
    minHeight: 96,
    paddingTop: spacing.md,
  },
  counter: {
    textAlign: 'right',
  },
  privacyRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  privacyCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.xl,
  },
  action: {
    flex: 1,
  },
});
