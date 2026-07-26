import { z } from 'zod';

import { apiRequest } from '@/lib/api';
import type { CalendarFeedCredential, CalendarFeedStatus } from '@/types';

const statusSchema = z.object({ enabled: z.boolean() });
const credentialSchema = z.object({ feed_url: z.string().url().max(2_048) });

export async function fetchCalendarFeedStatus(): Promise<CalendarFeedStatus> {
  return statusSchema.parse(await apiRequest<unknown>('/calendar/feed'));
}

/** Enable or regenerate the feed; returns the plaintext URL shown only once. */
export async function enableCalendarFeed(): Promise<CalendarFeedCredential> {
  return credentialSchema.parse(await apiRequest<unknown>('/calendar/feed', { method: 'POST' }));
}

export async function disableCalendarFeed(): Promise<void> {
  await apiRequest('/calendar/feed', { method: 'DELETE' });
}
