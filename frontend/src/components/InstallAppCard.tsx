import {
  ChevronRight,
  Download,
  Share2,
  SquarePlus,
} from 'lucide-react';
import { usePwaInstall } from '@/hooks/usePwaInstall';

export function InstallAppCard() {
  const {
    canInstall,
    install,
    isStandalone,
    needsManualInstall,
  } = usePwaInstall();
  if ((!canInstall && !needsManualInstall) || isStandalone) return null;

  return (
    <section className="rounded-lg border border-[hsl(var(--border))] p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Download className="h-5 w-5 text-[hsl(var(--primary))]" /> Install Văzute
      </h2>
      {canInstall ? (
        <button
          type="button"
          onClick={() => void install()}
          className="mt-4 flex h-10 items-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 text-sm font-medium text-white hover:opacity-90"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Install app
        </button>
      ) : (
        <>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
            Open this page in Safari, then:
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <Share2 className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
              Share
            </span>
            <ChevronRight
              className="h-4 w-4 text-[hsl(var(--muted-foreground))]"
              aria-hidden="true"
            />
            <span className="flex items-center gap-2">
              <SquarePlus
                className="h-5 w-5 text-[hsl(var(--primary))]"
                aria-hidden="true"
              />
              Add to Home Screen
            </span>
          </div>
        </>
      )}
    </section>
  );
}
