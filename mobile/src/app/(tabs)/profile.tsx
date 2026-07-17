import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  ChevronRight,
  Bell,
  ChartNoAxesColumnIncreasing,
  Database,
  ExternalLink,
  History,
  ListPlus,
  LogOut,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react-native';
import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ScreenHeader } from '@/components/screen-header';
import { TmdbLogo } from '@/components/tmdb-logo';
import { spacing } from '@/constants/theme';
import { useMyStats } from '@/hooks/use-stats';
import { useNotificationSummary } from '@/hooks/use-notifications';
import { useTheme } from '@/hooks/use-theme';
import { logoutSession } from '@/lib/session';
import { useAuthStore } from '@/store/auth';

export default function ProfileScreen() {
  const theme = useTheme();
  const user = useAuthStore((state) => state.user);
  const stats = useMyStats();
  const notifications = useNotificationSummary();
  const unreadCount = notifications.data?.unread_count ?? 0;
  const [loggingOut, setLoggingOut] = useState(false);
  const initial = user?.username.charAt(0).toUpperCase() || '?';

  const logout = async () => {
    setLoggingOut(true);
    try {
      await logoutSession();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ScreenHeader title="Profile" subtitle={user?.email} />

        <View style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
            <AppText variant="title" style={{ color: theme.primary }}>
              {initial}
            </AppText>
          </View>
          <View style={styles.identityCopy}>
            <AppText variant="section" numberOfLines={2}>
              {user?.username}
            </AppText>
            <View style={styles.privacy}>
              <ShieldCheck color={theme.success} size={16} />
              <AppText variant="caption" muted>
                {user?.is_public ? 'Public profile' : 'Private profile'}
              </AppText>
            </View>
          </View>
        </View>

        {stats.data ? (
          <View style={[styles.stats, { borderColor: theme.border }]}>
            <ProfileStat label="Movies" value={stats.data.total_movies} />
            <ProfileStat label="Shows" value={stats.data.total_shows} />
            <ProfileStat label="Episodes" value={stats.data.total_episodes} />
            <ProfileStat label="Hours" value={Math.round(stats.data.total_hours)} />
          </View>
        ) : null}

        <View style={styles.section}>
          <AppText variant="section">Account</AppText>
          <View style={[styles.navigationGroup, { borderTopColor: theme.border }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open social"
            onPress={() => router.push('/social')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <Users color={theme.mutedText} size={20} />
              <AppText variant="label">Social</AppText>
            </View>
            <ChevronRight color={theme.mutedText} size={18} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open notifications${
              unreadCount
                ? `, ${unreadCount} unread`
                : ''
            }`}
            onPress={() => router.push('/notifications')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <Bell color={theme.mutedText} size={20} />
              <AppText variant="label">Notifications</AppText>
            </View>
            <View style={styles.navigationMeta}>
              {unreadCount > 0 ? (
                <View style={[styles.countBadge, { backgroundColor: theme.danger }]}>
                  <AppText variant="caption" style={styles.countBadgeText}>
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </AppText>
                </View>
              ) : null}
              <ChevronRight color={theme.mutedText} size={18} />
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open statistics"
            onPress={() => router.push('/statistics')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <ChartNoAxesColumnIncreasing color={theme.mutedText} size={20} />
              <AppText variant="label">Statistics</AppText>
            </View>
            <ChevronRight color={theme.mutedText} size={18} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open watch history"
            onPress={() => router.push('/history')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <History color={theme.mutedText} size={20} />
              <AppText variant="label">Watch history</AppText>
            </View>
            <ChevronRight color={theme.mutedText} size={18} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open custom lists"
            onPress={() => router.push('/lists')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <ListPlus color={theme.mutedText} size={20} />
              <AppText variant="label">Custom lists</AppText>
            </View>
            <ChevronRight color={theme.mutedText} size={18} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open account settings"
            onPress={() => router.push('/settings')}
            style={({ pressed }) => [
              styles.navigationRow,
              {
                borderColor: theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}
          >
            <View style={styles.navigationLabel}>
              <Settings color={theme.mutedText} size={20} />
              <AppText variant="label">Account settings</AppText>
            </View>
            <ChevronRight color={theme.mutedText} size={18} />
          </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionTitle}>
            <Database color={theme.info} size={20} />
            <AppText variant="section">Data sources</AppText>
          </View>

          <View style={[styles.sourceRow, { borderColor: theme.border }]}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open The Movie Database"
              onPress={() => void Linking.openURL('https://www.themoviedb.org')}
              style={({ pressed }) => [{ opacity: pressed ? 0.72 : 1 }]}
            >
              <TmdbLogo />
            </Pressable>
            <AppText muted>
              Movie and TV metadata and images are provided by The Movie Database.
            </AppText>
            <AppText variant="caption">
              This product uses the TMDB API but is not endorsed or certified by TMDB.
            </AppText>
          </View>

          <View style={[styles.sourceRow, { borderColor: theme.border }]}>
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="Open JustWatch Romania"
              onPress={() => void Linking.openURL('https://www.justwatch.com/ro')}
              style={({ pressed }) => [
                styles.justWatchLink,
                { opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <AppText variant="section" style={{ color: '#FBC500' }}>
                JustWatch
              </AppText>
              <ExternalLink color="#FBC500" size={16} />
            </Pressable>
            <AppText muted>
              Streaming availability data, when displayed, is provided by JustWatch.
            </AppText>
          </View>
        </View>

        <View style={styles.footer}>
          <AppText variant="caption" muted>
            Văzute {Constants.expoConfig?.version || '1.0.0'}
          </AppText>
          <AppButton
            label="Sign out"
            icon={<LogOut color="#FFFFFF" size={18} />}
            variant="danger"
            loading={loggingOut}
            onPress={() => void logout()}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileStat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <AppText variant="section">{value}</AppText>
      <AppText variant="caption" muted>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.xl,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.sm,
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  stats: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.lg,
  },
  stat: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: spacing.xs,
  },
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navigationRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.xs,
  },
  navigationGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  navigationLabel: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navigationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
  sourceRow: {
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.lg,
  },
  justWatchLink: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  footer: {
    gap: spacing.lg,
    paddingTop: spacing.md,
  },
});
