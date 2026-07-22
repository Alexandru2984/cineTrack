const ONE_TIME_TOKEN_PATTERN = /^[0-9a-f]{128}$/i;

export function readFragmentOneTimeToken(fragment: string): string {
  const candidate = new URLSearchParams(fragment.replace(/^#/, '')).get('token');
  return candidate && ONE_TIME_TOKEN_PATTERN.test(candidate) ? candidate : '';
}

export function scrubOneTimeTokenUrl(): void {
  const search = new URLSearchParams(window.location.search);
  search.delete('token');
  const remainingSearch = search.toString();
  const cleanUrl = `${window.location.pathname}${remainingSearch ? `?${remainingSearch}` : ''}`;

  if (window.location.hash || cleanUrl !== `${window.location.pathname}${window.location.search}`) {
    window.history.replaceState(null, '', cleanUrl);
  }
}
