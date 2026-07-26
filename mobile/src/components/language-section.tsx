import { Languages } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { SegmentedControl } from '@/components/segmented-control';
import { spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { SUPPORTED_LOCALES, type Locale } from '@/lib/i18n';
import { useLocaleStore } from '@/store/locale';

/** Settings section to switch the UI language. */
export function LanguageSection() {
  const theme = useTheme();
  const t = useT();
  const locale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);

  const options: readonly { value: Locale; label: string }[] = SUPPORTED_LOCALES.map((code) => ({
    value: code,
    label: code === 'en' ? t('language.english') : t('language.romanian'),
  }));

  return (
    <View style={[styles.section, { borderBottomColor: theme.border }]}>
      <View style={styles.heading}>
        <Languages color={theme.primary} size={20} />
        <View style={styles.headingCopy}>
          <AppText variant="section">{t('language.title')}</AppText>
          <AppText variant="caption" muted>
            {t('language.description')}
          </AppText>
        </View>
      </View>
      <SegmentedControl value={locale} options={options} onChange={setLocale} />
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
});
