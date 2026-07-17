import { Image } from 'expo-image';
import { UserRound } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

export function UserAvatar({ uri, size = 48 }: { uri: string | null; size?: number }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.frame,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.surface },
      ]}
    >
      {uri ? (
        <Image source={{ uri }} contentFit="cover" transition={120} style={styles.image} />
      ) : (
        <UserRound color={theme.mutedText} size={Math.max(18, size / 2)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexShrink: 0,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
});
