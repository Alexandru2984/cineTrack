import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      <ActivityIndicator color={theme.primary} />
      <AppText muted>{label}</AppText>
    </View>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.container}>
      <Icon color={theme.mutedText} size={30} />
      <AppText variant="section" style={styles.center}>
        {title}
      </AppText>
      <AppText muted style={styles.center}>
        {message}
      </AppText>
      {actionLabel && onAction ? (
        <AppButton label={actionLabel} variant="secondary" compact onPress={onAction} />
      ) : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.container}>
      <AppText variant="section" style={styles.center}>
        Could not load
      </AppText>
      <AppText muted style={styles.center}>
        {message}
      </AppText>
      <AppButton label="Try again" variant="secondary" compact onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 220,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  center: {
    textAlign: 'center',
  },
});
