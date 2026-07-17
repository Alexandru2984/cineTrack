import { apiRequest } from '@/lib/api';
import { clearLocalSession } from '@/lib/session';

export async function deleteAccountSession(password: string) {
  await apiRequest<{ message: string }>('/users/me', {
    method: 'DELETE',
    body: { password },
  });
  await clearLocalSession();
}
