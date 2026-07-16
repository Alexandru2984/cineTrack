import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  type PressableProps,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger';

interface AppButtonProps extends PressableProps {
  label: string;
  icon?: ReactNode;
  loading?: boolean;
  variant?: ButtonVariant;
  compact?: boolean;
}

export function AppButton({
  label,
  icon,
  loading = false,
  variant = 'primary',
  compact = false,
  disabled,
  style,
  ...props
}: AppButtonProps) {
  const theme = useTheme();
  const palette = {
    primary: { background: theme.primary, foreground: '#FFFFFF', border: theme.primary },
    secondary: { background: theme.elevated, foreground: theme.text, border: theme.border },
    success: { background: theme.success, foreground: '#FFFFFF', border: theme.success },
    danger: { background: theme.danger, foreground: '#FFFFFF', border: theme.danger },
  }[variant];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      {...props}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compact : styles.regular,
        {
          backgroundColor: palette.background,
          borderColor: palette.border,
          opacity: isDisabled ? 0.55 : pressed ? 0.78 : 1,
        },
        typeof style === 'function' ? style({ pressed }) : style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.foreground} size="small" />
      ) : (
        <View style={styles.content}>
          {icon}
          <AppText variant="label" style={{ color: palette.foreground }}>
            {label}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  regular: {
    minHeight: 46,
    paddingHorizontal: spacing.lg,
  },
  compact: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
});
