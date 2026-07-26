import { CalendarClock } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Share, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { spacing } from '@/constants/theme';
import {
  useCalendarFeedStatus,
  useDisableCalendarFeed,
  useEnableCalendarFeed,
} from '@/hooks/use-calendar';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';

/**
 * Manage the subscribable iCal feed. The plaintext URL is returned only when
 * the feed is generated, so it is revealed once (selectable + shareable) with a
 * warning; the server stores only its hash.
 */
export function CalendarFeedSection() {
  const theme = useTheme();
  const t = useT();
  const status = useCalendarFeedStatus();
  const enableFeed = useEnableCalendarFeed();
  const disableFeed = useDisableCalendarFeed();
  const [revealedUrl, setRevealedUrl] = useState<string | null>(null);

  const enabled = status.data?.enabled ?? false;

  const generate = () => {
    enableFeed.mutate(undefined, { onSuccess: (data) => setRevealedUrl(data.feed_url) });
  };

  const disable = () => {
    disableFeed.mutate(undefined, { onSuccess: () => setRevealedUrl(null) });
  };

  const shareUrl = async () => {
    if (!revealedUrl) return;
    try {
      await Share.share({ message: revealedUrl });
    } catch {
      // The share sheet was dismissed; nothing to do.
    }
  };

  const error = enableFeed.error ?? disableFeed.error;

  return (
    <View style={[styles.section, { borderBottomColor: theme.border }]}>
      <View style={styles.heading}>
        <CalendarClock color={theme.primary} size={20} />
        <View style={styles.headingCopy}>
          <AppText variant="section">{t('calendarFeed.title')}</AppText>
          <AppText variant="caption" muted>
            {t('calendarFeed.subtitle')}
          </AppText>
        </View>
      </View>
      <AppText muted>{t('calendarFeed.description')}</AppText>

      {status.isLoading ? (
        <ActivityIndicator color={theme.primary} />
      ) : revealedUrl ? (
        <View style={styles.revealed}>
          <AppText variant="caption" muted>
            {t('calendarFeed.revealWarning')}
          </AppText>
          <AppText selectable style={[styles.url, { color: theme.primary }]}>
            {revealedUrl}
          </AppText>
          <AppButton
            variant="secondary"
            label={t('calendarFeed.share')}
            onPress={() => void shareUrl()}
          />
        </View>
      ) : null}

      <View style={styles.actions}>
        {enabled ? (
          <>
            <AppButton
              variant="secondary"
              label={t('calendarFeed.regenerate')}
              loading={enableFeed.isPending}
              onPress={generate}
            />
            <AppButton
              variant="danger"
              label={t('calendarFeed.disable')}
              loading={disableFeed.isPending}
              onPress={disable}
            />
          </>
        ) : (
          <AppButton
            label={t('calendarFeed.generate')}
            loading={enableFeed.isPending}
            onPress={generate}
          />
        )}
      </View>

      {error ? (
        <AppText variant="caption" style={{ color: theme.danger }}>
          {getErrorMessage(error, t('calendarFeed.error'))}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headingCopy: {
    flex: 1,
    gap: 2,
  },
  revealed: {
    gap: spacing.sm,
  },
  url: {
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
