import { Image } from 'expo-image';
import { Film } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  API_BASE_URL,
  TMDB_IMAGE_BASE_URL,
  USE_R2_IMAGES,
} from '@/lib/config';

export function imageUrl(path: string | null | undefined, size = 'w342') {
  if (!path) return null;
  return USE_R2_IMAGES
    ? `${API_BASE_URL}/img/${size}${path}`
    : `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export function Poster({
  path,
  width = 58,
  height = 87,
}: {
  path: string | null | undefined;
  width?: number;
  height?: number;
}) {
  const theme = useTheme();
  const uri = imageUrl(path);
  if (!uri) {
    return (
      <View
        style={[
          styles.placeholder,
          { width, height, backgroundColor: theme.surface, borderColor: theme.border },
        ]}
      >
        <Film color={theme.mutedText} size={Math.min(width / 2, 24)} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      contentFit="cover"
      transition={120}
      style={[styles.image, { width, height, backgroundColor: theme.surface }]}
    />
  );
}

const styles = StyleSheet.create({
  image: {
    borderRadius: radius.sm,
  },
  placeholder: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
