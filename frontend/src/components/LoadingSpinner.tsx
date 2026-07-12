import { Loader2 } from 'lucide-react';

export function LoadingSpinner() {
  return (
    <div
      className="flex items-center justify-center py-12"
      role="status"
      aria-label="Loading"
    >
      <Loader2
        className="h-8 w-8 animate-spin text-[hsl(var(--primary))]"
        aria-hidden="true"
      />
    </div>
  );
}
