import { fireEvent, render, screen } from '@testing-library/react-native';

import {
  SIGNED_IN_HOME_ROUTE,
  SIGNED_OUT_ROUTE,
  SignedOutRedirect,
} from '@/components/signed-out-redirect';
import { hydrateSession } from '@/lib/session';

jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return { Redirect: ({ href }: { href: string }) => <MockText>{`redirect:${href}`}</MockText> };
});
jest.mock('@/hooks/use-t', () => ({ useT: () => (key: string) => key }));
jest.mock('@/lib/session', () => ({ hydrateSession: jest.fn(() => Promise.resolve()) }));
jest.mock('@/components/screen-state', () => {
  const { Pressable, Text: MockText } = jest.requireActual('react-native');
  return {
    LoadingState: ({ label }: { label: string }) => <MockText>{`loading:${label}`}</MockText>,
    ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
      <Pressable accessibilityRole="button" onPress={onRetry}>
        <MockText>{`error:${message}`}</MockText>
      </Pressable>
    ),
  };
});

describe('SignedOutRedirect', () => {
  it('sends a signed-out member to the sign-in route, never to the ambiguous root', async () => {
    await render(<SignedOutRedirect status="anonymous" />);
    expect(screen.getByText(`redirect:${SIGNED_OUT_ROUTE}`)).toBeTruthy();
    expect(SIGNED_OUT_ROUTE).not.toBe('/');
  });

  it('sends a member who is only offline home, not to the sign-in form', async () => {
    await render(<SignedOutRedirect status="offline" />);
    expect(screen.getByText(`redirect:${SIGNED_IN_HOME_ROUTE}`)).toBeTruthy();
  });

  it('waits while the session is still being restored', async () => {
    await render(<SignedOutRedirect status="loading" />);
    expect(screen.getByText('loading:session.restoring')).toBeTruthy();
    expect(screen.queryByText(/^redirect:/)).toBeNull();
  });

  it('offers a retry when a stored session could not be restored', async () => {
    await render(<SignedOutRedirect status="restore_error" />);
    await fireEvent.press(screen.getByText('error:session.restoreError'));
    expect(hydrateSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/^redirect:/)).toBeNull();
  });
});
