import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fingerprint, generateIdentity, toHex } from '@/lib/crypto/core';
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
// The directory entry this page is given. `peerKeysData` is reassigned per test
// so one case can serve a substituted key while leaving the *stated*
// fingerprint alone — which is the attack the safety number has to survive.
let peerKeysData: {
  exchange_public_key: string;
  signing_public_key: string;
  key_fingerprint: string;
} | null = null;

vi.mock('@/hooks/useEncryption', () => ({
  usePeerKeys: () => ({ data: peerKeysData }),
}));

let ownFingerprint: string | null = null;

vi.mock('@/store/encryption', () => ({
  useEncryptionStore: (
    selector: (state: { identity: null; fingerprint: string | null; status: 'absent' }) => unknown,
  ) => selector({ identity: null, fingerprint: ownFingerprint, status: 'absent' }),
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
  beforeEach(() => {
    vi.clearAllMocks();
    peerKeysData = null;
    ownFingerprint = null;
  });

  /** The safety number the page actually renders, read out of the panel.
   *
   *  Opened through the button because the number is hidden until asked for. */
  async function readSafetyNumber() {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Safety number' }));
    const panel = await screen.findByText(/^[0-9a-f]{4}( [0-9a-f]{4}){9}$/);
    return panel.textContent ?? '';
  }

  it('derives the safety number from the peer key, not from the fingerprint it is handed', async () => {
    // The attack, end to end, at the only place it was ever visible.
    //
    // A server that wants to read Alice's mail serves Bob's directory entry
    // with the attacker's exchange key — so `sealMessage` encrypts to the
    // attacker — while leaving the *stated* `key_fingerprint` at Bob's old
    // value. The page used to render that stated value, so the number Alice
    // read aloud to Bob over the phone had not changed, and the comparison the
    // whole feature exists for silently agreed with the attacker.
    const bob = generateIdentity();
    const attacker = generateIdentity();
    const bobsStatedFingerprint = fingerprint(bob.exchangePublicKey, bob.signingPublicKey);

    ownFingerprint = 'a'.repeat(64);

    peerKeysData = {
      exchange_public_key: toHex(bob.exchangePublicKey),
      signing_public_key: toHex(bob.signingPublicKey),
      key_fingerprint: bobsStatedFingerprint,
    };
    renderMessages();
    const honest = await readSafetyNumber();

    cleanup();

    peerKeysData = {
      // Substituted key, untouched stated fingerprint.
      exchange_public_key: toHex(attacker.exchangePublicKey),
      signing_public_key: toHex(bob.signingPublicKey),
      key_fingerprint: bobsStatedFingerprint,
    };
    renderMessages();
    const substituted = await readSafetyNumber();

    expect(substituted).not.toBe(honest);
  });

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
