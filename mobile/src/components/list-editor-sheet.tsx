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
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import {
  LIST_DESCRIPTION_MAX_LENGTH,
  LIST_NAME_MAX_LENGTH,
  listInputFromDraft,
  type ListInput,
} from '@/lib/lists';

interface EditableList {
  name: string;
  description: string | null;
  is_public: boolean;
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
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const [isPublic, setIsPublic] = useState(list?.is_public ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);

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
                  <AppText variant="section">{list ? 'Edit list' : 'Create list'}</AppText>
                  <AppText variant="caption" muted>
                    Organize titles independently from tracking status.
                  </AppText>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close list editor"
                  disabled={pending}
                  onPress={onClose}
                  style={[styles.iconButton, { borderColor: theme.border }]}
                >
                  <X color={theme.mutedText} size={20} />
                </Pressable>
              </View>

              <View style={styles.form}>
                <View style={styles.fieldGroup}>
                  <AppText variant="label">Name</AppText>
                  <TextInput
                    accessibilityLabel="List name"
                    autoFocus
                    value={name}
                    onChangeText={(value) => {
                      setName(value);
                      setValidationError(null);
                    }}
                    maxLength={LIST_NAME_MAX_LENGTH}
                    placeholder="Weekend movies"
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
                  <AppText variant="label">Description</AppText>
                  <TextInput
                    accessibilityLabel="List description"
                    multiline
                    value={description}
                    onChangeText={setDescription}
                    maxLength={LIST_DESCRIPTION_MAX_LENGTH}
                    placeholder="Optional context for this collection"
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
                    <AppText variant="label">Public list</AppText>
                    <AppText variant="caption" muted>
                      Anyone with its link can view it.
                    </AppText>
                  </View>
                  <Switch
                    accessibilityLabel="Public list"
                    value={isPublic}
                    onValueChange={setIsPublic}
                    trackColor={{ false: theme.border, true: theme.primarySoft }}
                    thumbColor={isPublic ? theme.primary : theme.mutedText}
                  />
                </View>

                {validationError || error ? (
                  <AppText variant="caption" style={{ color: theme.danger }}>
                    {validationError ?? getErrorMessage(error, 'The list could not be saved')}
                  </AppText>
                ) : null}
              </View>

              <View style={styles.actions}>
                <AppButton
                  label="Cancel"
                  variant="secondary"
                  disabled={pending}
                  onPress={onClose}
                  style={styles.action}
                />
                <AppButton
                  label={list ? 'Save changes' : 'Create list'}
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
