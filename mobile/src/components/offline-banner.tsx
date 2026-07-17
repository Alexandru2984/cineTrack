import { RefreshCw, WifiOff } from 'lucide-react-native';
import { onlineManager } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { resumeOfflineSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

export function OfflineBanner() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const [retrying, setRetrying] = useState(false);
  if (status !== 'offline') return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await resumeOfflineSession();
      if (useAuthStore.getState().status === 'authenticated') {
        onlineManager.setOnline(true);
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <SafeAreaView
      edges={['top']}
      style={{ backgroundColor: theme.warningSoft }}
    >
      <View style={styles.row}>
        <WifiOff color={theme.warning} size={16} />
        <AppText variant="caption" style={[styles.copy, { color: theme.warning }]}>
          Offline · showing saved data
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry connection"
          disabled={retrying}
          onPress={() => void retry()}
          style={({ pressed }) => [
            styles.retry,
            { opacity: retrying ? 0.45 : pressed ? 0.72 : 1 },
          ]}
        >
          <RefreshCw color={theme.warning} size={16} />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  retry: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
