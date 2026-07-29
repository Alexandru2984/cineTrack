import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { z } from 'zod';

import { apiRequest } from '@/lib/api';
import { ApiError } from '@/lib/http';

const EXPORT_FILE_NAME = 'vazute-account-export.json';
const MAX_EXPORT_CHARACTERS = 96 * 1024 * 1024;

const accountExportSchema = z.object({
  format_version: z.literal(1),
  exported_at: z.string().datetime({ offset: true }),
  account: z.object({
    id: z.string().uuid(),
    username: z.string().min(1).max(50),
    email: z.string().email().max(255),
    avatar_url: z.string().nullable(),
    bio: z.string().nullable(),
    is_public: z.boolean(),
    email_verified: z.boolean(),
    two_factor_enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
  library: z.array(z.unknown()).max(10_000),
  watch_history: z.array(z.unknown()).max(100_000),
  lists: z.array(z.unknown()).max(50),
  relationships: z.array(z.unknown()).max(10_000),
  episode_plans: z.array(z.unknown()).max(10_000),
  episode_reactions: z.array(z.unknown()).max(100_000),
  notifications: z.array(z.unknown()).max(5_000),
  sessions: z.array(z.unknown()).max(10_000),
  notification_devices: z.array(z.unknown()).max(10),
  import_jobs: z.array(z.unknown()).max(10_000),
  calendar_preferences: z.unknown().nullable(),
  oauth_accounts: z.array(z.unknown()).max(20),
});

export type AccountDataExport = z.infer<typeof accountExportSchema>;

export async function requestAccountDataExport(password: string, totpCode?: string) {
  if (!password || password.length > 128) {
    throw new ApiError('Enter your current password', 400);
  }
  const code = totpCode?.trim();
  const payload = await apiRequest<unknown>('/users/me/export', {
    method: 'POST',
    body: { password, ...(code ? { totp_code: code } : {}) },
    timeoutMs: 60_000,
  });
  return accountExportSchema.parse(payload);
}

export async function exportAndShareAccountData(password: string, totpCode?: string) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ApiError('File sharing is not available on this device', 0);
  }

  const file = new File(Paths.cache, EXPORT_FILE_NAME);
  // Remove an interrupted prior attempt before asking the server for another
  // private snapshot.
  if (file.exists) file.delete();

  const payload = await requestAccountDataExport(password, totpCode);
  const contents = JSON.stringify(payload, null, 2);
  if (contents.length > MAX_EXPORT_CHARACTERS) {
    throw new ApiError('The account export is too large for this device', 413);
  }

  try {
    file.create({ overwrite: true });
    file.write(contents);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: 'Save your Văzute account export',
      mimeType: 'application/json',
      UTI: 'public.json',
    });
  } finally {
    // The receiving application gets its own copy. Keep no plaintext export in
    // the Văzute cache after the share sheet closes or throws.
    if (file.exists) file.delete();
  }
}
