import { useColorScheme } from 'react-native';

import { colors } from '@/constants/theme';

export function useTheme() {
  return colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}
