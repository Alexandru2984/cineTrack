import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessagesPage from '@/pages/Messages';

const mocks = vi.hoisted(() => ({
  markRead: vi.fn(),
  send: vi.fn(),
}));

const unsafeMessage = '<img src=x onerror=alert(1)>';

vi.mock('@/hooks/useMessages', () => ({
  useMessageConversations: () => ({
    data: { pages: [[]] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useMessageThread: () => ({
    data: {
      pages: [
        {
          user: { id: 'alice-id', username: 'alice', avatar_url: null },
          can_message: true,
          messages: [
            {
              id: 'message-1',
              sender_id: 'alice-id',
              recipient_id: 'me-id',
              body: unsafeMessage,
              read_at: null,
              created_at: '2026-08-05T12:00:00Z',
            },
          ],
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useSendMessage: () => ({
    mutate: mocks.send,
    isPending: false,
    error: null,
  }),
  useMarkMessageThreadRead: () => ({
    mutate: mocks.markRead,
    isPending: false,
  }),
}));

vi.mock('@/store/auth', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'me-id' } }),
}));

vi.mock('@/store/locale', () => ({
  useLocaleStore: (selector: (state: { locale: 'en' }) => unknown) =>
    selector({ locale: 'en' }),
}));

// The page asks the directory whether the peer can be written to encrypted.
// Mocked alongside the message hooks so this test stays about rendering a
// thread rather than about query wiring; the encryption paths have their own
// tests.
vi.mock('@/hooks/useEncryption', () => ({
  usePeerKeys: () => ({ data: null }),
}));

vi.mock('@/store/encryption', () => ({
  useEncryptionStore: (
    selector: (state: { identity: null; fingerprint: null; status: 'absent' }) => unknown,
  ) => selector({ identity: null, fingerprint: null, status: 'absent' }),
}));

// Rendered whenever this device has no key. Stubbed so the setup form's own
// buttons and inputs do not compete with the thread's in the queries below —
// the gate has its own tests.
vi.mock('@/components/EncryptionGate', () => ({
  EncryptionGate: () => null,
}));

vi.mock('@/components/ReportDialog', () => ({
  ReportDialog: ({
    targetType,
    targetId,
  }: {
    targetType: string;
    targetId: string;
  }) => <div role="dialog">{`${targetType}:${targetId}`}</div>,
}));

function renderMessages() {
  return render(
    <MemoryRouter initialEntries={['/messages/alice']}>
      <Routes>
        <Route path="/messages/:username" element={<MessagesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Messages page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders message bodies as text, marks incoming messages read, and reports them', async () => {
    const user = userEvent.setup();
    renderMessages();

    expect(screen.getByText(unsafeMessage)).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
    await waitFor(() => {
      expect(mocks.markRead).toHaveBeenCalledWith(
        { username: 'alice', throughId: 'message-1' },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    await user.click(screen.getByRole('button', { name: 'Report message' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('message:message-1');
  });

  it('reuses the idempotency nonce when retrying the same message', async () => {
    const user = userEvent.setup();
    renderMessages();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '  Hello Alice  ');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      username: 'alice',
      body: 'Hello Alice',
    });
    expect(mocks.send.mock.calls[1][0].clientNonce).toBe(
      mocks.send.mock.calls[0][0].clientNonce,
    );
  });
});
