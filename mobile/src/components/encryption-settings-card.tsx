import { StyleSheet, View } from 'react-native';
import { MessageSquareLock } from 'lucide-react-native';

import { AppText } from '@/components/app-text';
import { EncryptionGate } from '@/components/encryption-gate';
import { useT } from '@/hooks/use-t';
import { encryptionHintKey } from '@/lib/encryption-hint';
import { useEncryptionStore } from '@/store/encryption';
import { spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Message encryption, reachable without a conversation.
 *
 *  It was offered in exactly one place: inside a thread with somebody who could
 *  already be messaged. Direct messages need a mutual follow, so finding it
 *  needed a friend, an open conversation and a reason to look — and across
 *  eleven accounts, nobody had ever set it up.
 *
 *  The forms are reused untouched: this renders the same EncryptionGate that
 *  already handles setup, restore, the recovery code shown once, and a device
 *  that cannot store keys. It adds a door, not a second implementation of a
 *  security flow.
 */
export function EncryptionSettingsCard() {
  const t = useT();
  const theme = useTheme();
  const status = useEncryptionStore((state) => state.status);
  const hintKey = encryptionHintKey(status);
  const hint = hintKey ? t(hintKey) : null;

  return (
    <View style={[styles.section, { borderBottomColor: theme.border }]}>
      <View style={styles.sectionHeading}>
        <MessageSquareLock color={theme.primary} size={20} />
        <View style={styles.headingCopy}>
          <AppText variant="section">{t('encryption.settingsTitle')}</AppText>
          {hint ? (
            <AppText variant="caption" muted>
              {hint}
            </AppText>
          ) : null}
        </View>
      </View>
      {/* Renders nothing once a key is loaded, which is why the hint above
          carries the state rather than relying on the gate to show something. */}
      <EncryptionGate />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.lg,
    paddingBottom: spacing.xxl,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeading: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
    gap: spacing.xs,
  },
});
