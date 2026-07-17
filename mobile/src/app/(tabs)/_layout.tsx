import { Redirect, Tabs } from 'expo-router';
import {
  CalendarDays,
  Home,
  Library,
  Search,
  UserRound,
} from 'lucide-react-native';

import { LoadingState } from '@/components/screen-state';
import { useTheme } from '@/hooks/use-theme';
import { useNotificationSummary } from '@/hooks/use-notifications';
import { hasLocalSession, useAuthStore } from '@/store/auth';

export default function TabsLayout() {
  const theme = useTheme();
  const status = useAuthStore((state) => state.status);
  const notificationSummary = useNotificationSummary(status === 'authenticated', true);
  const unreadCount = notificationSummary.data?.unread_count ?? 0;

  if (status === 'loading') return <LoadingState label="Restoring session" />;
  if (!hasLocalSession(status)) return <Redirect href="/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: theme.background },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.mutedText,
        tabBarStyle: {
          backgroundColor: theme.elevated,
          borderTopColor: theme.border,
          height: 64,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          lineHeight: 14,
          fontWeight: '600',
        },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ color, size }) => <CalendarDays color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: ({ color, size }) => <Search color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color, size }) => <Library color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <UserRound color={color} size={size} />,
          tabBarBadge: unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.danger,
            color: '#FFFFFF',
            fontSize: 10,
          },
        }}
      />
    </Tabs>
  );
}
