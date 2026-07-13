export function DataAttribution() {
  return (
    <footer className="border-t border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-2 px-4 py-5 text-center sm:flex-row sm:justify-center sm:gap-4 sm:px-6 sm:text-left lg:px-8">
        <a
          href="https://www.themoviedb.org"
          target="_blank"
          rel="noreferrer"
          aria-label="The Movie Database"
          className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <img src="/tmdb-logo.svg" alt="TMDB" className="h-auto w-28" width="273" height="36" />
        </a>
        <p className="max-w-2xl text-xs leading-5 text-[hsl(var(--muted-foreground))]">
          This website uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise
          approved by TMDB.
        </p>
      </div>
    </footer>
  );
}
