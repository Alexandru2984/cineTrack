import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore } from '@/store/theme';

describe('useThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    // Reset to default
    useThemeStore.setState({ isDark: false });
  });

  it('has isDark property', () => {
    const state = useThemeStore.getState();
    expect(typeof state.isDark).toBe('boolean');
  });

  it('toggle flips isDark from false to true', () => {
    useThemeStore.setState({ isDark: false });
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().isDark).toBe(true);
  });

  it('toggle flips isDark from true to false', () => {
    useThemeStore.setState({ isDark: true });
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().isDark).toBe(false);
  });

  it('toggle adds dark class to documentElement', () => {
    useThemeStore.setState({ isDark: false });
    useThemeStore.getState().toggle();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle removes dark class', () => {
    document.documentElement.classList.add('dark');
    useThemeStore.setState({ isDark: true });
    useThemeStore.getState().toggle();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggle persists to localStorage', () => {
    useThemeStore.setState({ isDark: false });
    useThemeStore.getState().toggle();
    expect(localStorage.getItem('cinetrack-theme')).toBe('dark');
  });

  it('setDark(true) sets isDark and applies class', () => {
    useThemeStore.getState().setDark(true);
    expect(useThemeStore.getState().isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('cinetrack-theme')).toBe('dark');
  });

  it('setDark(false) clears isDark and removes class', () => {
    document.documentElement.classList.add('dark');
    useThemeStore.getState().setDark(false);
    expect(useThemeStore.getState().isDark).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('cinetrack-theme')).toBe('light');
  });
});
