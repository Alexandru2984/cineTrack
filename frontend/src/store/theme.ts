import { create } from 'zustand';

interface ThemeState {
  isDark: boolean;
  toggle: () => void;
  setDark: (dark: boolean) => void;
}

function getInitialDark(): boolean {
  const stored = localStorage.getItem('cinetrack-theme');
  if (stored) return stored === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(dark: boolean) {
  if (dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  localStorage.setItem('cinetrack-theme', dark ? 'dark' : 'light');
}

export const useThemeStore = create<ThemeState>((set) => ({
  isDark: getInitialDark(),
  toggle: () =>
    set((state) => {
      const next = !state.isDark;
      applyTheme(next);
      return { isDark: next };
    }),
  setDark: (dark: boolean) => {
    applyTheme(dark);
    set({ isDark: dark });
  },
}));
