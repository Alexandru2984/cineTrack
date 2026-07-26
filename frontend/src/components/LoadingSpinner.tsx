import { Loader2 } from 'lucide-react';
import { useT } from '@/hooks/useT';

export function LoadingSpinner() {
  const t = useT();
  return (
    <div
      className="flex items-center justify-center py-12"
      role="status"
      aria-label={t('common.loading')}
    >
      <Loader2
        className="h-8 w-8 animate-spin text-[hsl(var(--primary))]"
        aria-hidden="true"
      />
    </div>
  );
}
