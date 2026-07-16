import { CalendarDays, Home, List, Search, User } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useCalendarSummary } from '@/hooks/useCalendar';
import { useAuthStore } from '@/store/auth';

interface MobileTab {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  active: (pathname: string) => boolean;
}

export function MobileTabBar() {
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const calendarSummary = useCalendarSummary(true);
  const newEpisodeCount = calendarSummary.data?.new_count ?? 0;
  const profileHref = user
    ? `/profile/${encodeURIComponent(user.username)}`
    : '/settings';
  const tabs: MobileTab[] = [
    {
      label: 'Home',
      href: '/',
      icon: Home,
      active: (pathname) => pathname === '/',
    },
    {
      label: 'Calendar',
      href: '/calendar',
      icon: CalendarDays,
      active: (pathname) => pathname.startsWith('/calendar'),
    },
    {
      label: 'Search',
      href: '/search',
      icon: Search,
      active: (pathname) => pathname.startsWith('/search'),
    },
    {
      label: 'Library',
      href: '/tracking',
      icon: List,
      active: (pathname) => pathname.startsWith('/tracking'),
    },
    {
      label: 'Profile',
      href: profileHref,
      icon: User,
      active: (pathname) =>
        pathname.startsWith('/profile/')
        || pathname.startsWith('/settings')
        || pathname.startsWith('/stats'),
    },
  ];

  return (
    <nav
      aria-label="Primary mobile navigation"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <div className="mx-auto grid h-16 max-w-lg grid-cols-5">
        {tabs.map((tab) => {
          const active = tab.active(location.pathname);
          const Icon = tab.icon;
          const calendarLabel = tab.label === 'Calendar' && newEpisodeCount > 0
            ? `Calendar, ${newEpisodeCount} new episode${newEpisodeCount === 1 ? '' : 's'}`
            : tab.label;
          return (
            <Link
              key={tab.href}
              to={tab.href}
              aria-label={calendarLabel}
              aria-current={active ? 'page' : undefined}
              className={`relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 transition-colors ${
                active
                  ? 'text-[hsl(var(--primary))]'
                  : 'text-[hsl(var(--muted-foreground))]'
              }`}
            >
              <span className="relative">
                <Icon className="h-5 w-5" aria-hidden />
                {tab.label === 'Calendar' && newEpisodeCount > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-3 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-600 px-1 text-[9px] font-semibold leading-none text-white"
                  >
                    {newEpisodeCount > 99 ? '99+' : newEpisodeCount}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
