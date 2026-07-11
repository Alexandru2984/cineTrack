(function () {
  let theme = null;
  try {
    theme = localStorage.getItem('cinetrack-theme');
  } catch {
    // Fall back to the system preference when storage is unavailable.
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  if (theme === 'dark' || (!theme && prefersDark)) {
    document.documentElement.classList.add('dark');
  }
})();
