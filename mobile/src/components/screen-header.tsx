import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { spacing } from '@/constants/theme';

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.copy}>
        <AppText variant="title" numberOfLines={2}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText muted numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
});
