import { type TextProps, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

type TextVariant = 'title' | 'section' | 'body' | 'label' | 'caption';

interface AppTextProps extends TextProps {
  variant?: TextVariant;
  muted?: boolean;
}

export function AppText({
  variant = 'body',
  muted = false,
  style,
  ...props
}: AppTextProps) {
  const theme = useTheme();
  return (
    <Text
      {...props}
      style={[
        styles[variant],
        { color: muted ? theme.mutedText : theme.text },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
  },
  section: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
  },
  label: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
  },
  caption: {
    fontSize: 12,
    lineHeight: 17,
  },
});
