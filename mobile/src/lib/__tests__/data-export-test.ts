import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { apiRequest } from '@/lib/api';
import {
  exportAndShareAccountData,
  requestAccountDataExport,
} from '@/lib/data-export';

const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockFile = {
  uri: 'file:///cache/vazute-account-export.json',
  exists: false,
  create: mockCreate,
  write: mockWrite,
  delete: mockDelete,
};

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
  Paths: { cache: 'file:///cache' },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);
const mockIsAvailable = jest.mocked(Sharing.isAvailableAsync);
const mockShare = jest.mocked(Sharing.shareAsync);

function exportPayload() {
  return {
    format_version: 1,
    exported_at: '2026-07-25T20:00:00Z',
    account: {
      id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
      username: 'viewer',
      email: 'viewer@example.com',
      avatar_url: null,
      bio: null,
      is_public: false,
      email_verified: true,
      two_factor_enabled: true,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-07-25T00:00:00Z',
    },
    library: [],
    watch_history: [],
    lists: [],
    relationships: [],
    episode_plans: [],
    episode_reactions: [],
    notifications: [],
    sessions: [],
    notification_devices: [],
    import_jobs: [],
    calendar_preferences: { country_code: 'RO' },
    oauth_accounts: [],
  };
}

describe('mobile account data export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFile.exists = false;
  });

  it('requires a bounded password and validates the private export envelope', async () => {
    await expect(requestAccountDataExport('')).rejects.toMatchObject({ status: 400 });
    await expect(requestAccountDataExport('x'.repeat(129))).rejects.toMatchObject({
      status: 400,
    });
    expect(mockApiRequest).not.toHaveBeenCalled();

    mockApiRequest.mockResolvedValueOnce(exportPayload());
    await expect(requestAccountDataExport('Pass1234')).resolves.toMatchObject({
      format_version: 1,
      account: { email: 'viewer@example.com' },
    });
    expect(mockApiRequest).toHaveBeenCalledWith('/users/me/export', {
      method: 'POST',
      body: { password: 'Pass1234' },
      timeoutMs: 60_000,
    });
  });

  it('trims and sends a second factor when the account requires step-up', async () => {
    mockApiRequest.mockResolvedValueOnce(exportPayload());

    await requestAccountDataExport('Pass1234', ' aaaa-bbbb-cccc-dddd ');

    expect(mockApiRequest).toHaveBeenCalledWith('/users/me/export', {
      method: 'POST',
      body: {
        password: 'Pass1234',
        totp_code: 'aaaa-bbbb-cccc-dddd',
      },
      timeoutMs: 60_000,
    });
  });

  it('writes only to cache, shares JSON, and deletes the plaintext file', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockApiRequest.mockResolvedValueOnce(exportPayload());
    mockShare.mockImplementationOnce(async () => {
      mockFile.exists = true;
    });

    await exportAndShareAccountData('Pass1234');

    expect(File).toHaveBeenCalledWith(
      'file:///cache',
      'vazute-account-export.json',
    );
    expect(mockCreate).toHaveBeenCalledWith({ overwrite: true });
    expect(mockWrite).toHaveBeenCalledWith(expect.stringContaining('"format_version": 1'));
    expect(mockShare).toHaveBeenCalledWith(mockFile.uri, {
      dialogTitle: 'Save your Văzute account export',
      mimeType: 'application/json',
      UTI: 'public.json',
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('does not request private data when file sharing is unavailable', async () => {
    mockIsAvailable.mockResolvedValueOnce(false);

    await expect(exportAndShareAccountData('Pass1234')).rejects.toMatchObject({
      status: 0,
    });
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
