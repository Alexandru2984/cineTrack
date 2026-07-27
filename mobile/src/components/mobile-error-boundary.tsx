import { RotateCcw, TriangleAlert } from 'lucide-react-native';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { spacing } from '@/constants/theme';
import { useT } from '@/hooks/use-t';
import { useTheme } from '@/hooks/use-theme';
import { captureClientError } from '@/lib/client-errors';

interface MobileErrorBoundaryProps {
  children: ReactNode;
}

interface MobileErrorBoundaryState {
  failed: boolean;
}

export class MobileErrorBoundary extends Component<
  MobileErrorBoundaryProps,
  MobileErrorBoundaryState
> {
  state: MobileErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MobileErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void captureClientError(error, {
      componentStack: info.componentStack,
      isFatal: false,
    });
  }

  render() {
    if (this.state.failed) {
      return <MobileErrorFallback onRetry={() => this.setState({ failed: false })} />;
    }
    return this.props.children;
  }
}

export function MobileErrorFallback({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  const t = useT();
  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <TriangleAlert color={theme.danger} size={32} />
      <AppText variant="section" style={styles.centered}>
        {t('errorBoundary.title')}
      </AppText>
      <AppText muted style={styles.centered}>
        {t('errorBoundary.message')}
      </AppText>
      <AppButton
        label={t('common.tryAgain')}
        icon={<RotateCcw color="#FFFFFF" size={18} />}
        onPress={onRetry}
        style={styles.button}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  centered: {
    maxWidth: 360,
    textAlign: 'center',
  },
  button: {
    alignSelf: 'stretch',
    maxWidth: 360,
    marginTop: spacing.sm,
  },
});
