import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.option,
              {
                borderColor: selected ? theme.primary : theme.border,
                backgroundColor: selected ? theme.primary : theme.elevated,
                opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
              },
            ]}
          >
            <AppText
              variant="label"
              numberOfLines={1}
              style={{ color: selected ? '#FFFFFF' : theme.text }}
            >
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.sm,
  },
  option: {
    minHeight: 40,
    minWidth: 64,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
