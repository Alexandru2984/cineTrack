import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  BarChart3,
  Bell,
  CalendarDays,
  CheckCheck,
  Film,
  LogOut,
  ListPlus,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  User,
  X,
} from 'lucide-react';
import { NotificationList } from '@/components/NotificationList';
import { useLogout } from '@/hooks/useAuth';
import { useCalendarSummary } from '@/hooks/useCalendar';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationSummary,
} from '@/hooks/useNotifications';
import { useAuthStore } from '@/store/auth';
import { useThemeStore } from '@/store/theme';
import { useT } from '@/hooks/useT';

type Translate = (key: string, params?: Record<string, string | number>) => string;

function unreadLabel(t: Translate, count: number) {
  if (count === 0) return t('nav.notificationsNoUnread');
  return count === 1
    ? t('nav.notificationsUnreadOne')
    : t('nav.notificationsUnreadMany', { count });
}

function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[hsl(var(--destructive))] px-1 text-[10px] font-semibold leading-none text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function Navbar() {
  const t = useT();
  const { user, isAuthenticated } = useAuthStore();
  const { isDark, toggle } = useThemeStore();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const notificationButtonRef = useRef<HTMLButtonElement>(null);
  const authed = isAuthenticated();
  const logoutMutation = useLogout();
  const notificationSummary = useNotificationSummary(authed);
  const calendarSummary = useCalendarSummary(authed);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const unreadCount = notificationSummary.data?.unread_count ?? 0;
  const newEpisodeCount = calendarSummary.data?.new_count ?? 0;

  useEffect(() => {
    if (!notificationsOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !notificationsRef.current?.contains(event.target)
      ) {
        setNotificationsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNotificationsOpen(false);
        notificationButtonRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [notificationsOpen]);

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => navigate('/login'),
    });
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between md:h-16">
          <Link
            to="/"
            className="flex items-center gap-2 text-xl font-bold text-[hsl(var(--primary))]"
          >
            <Film className="h-6 w-6" />
            Văzute
          </Link>

          {authed && (
            <div className="hidden items-center gap-4 md:flex lg:gap-6">
              <Link
                to="/search"
                className="flex items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <Search className="h-4 w-4" /> {t('nav.search')}
              </Link>
              <Link
                to="/tracking"
                className="flex items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <BarChart3 className="h-4 w-4" /> {t('nav.myList')}
              </Link>
              <Link
                to="/calendar"
                className="flex items-center gap-1 text-sm transition-colors hover:text-cyan-600 dark:hover:text-cyan-400"
              >
                <CalendarDays className="h-4 w-4" /> {t('nav.calendar')}
                {newEpisodeCount > 0 && (
                  <span className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-cyan-600 px-1 text-[10px] font-semibold leading-none text-white">
                    {newEpisodeCount > 99 ? '99+' : newEpisodeCount}
                  </span>
                )}
              </Link>
              <Link
                to="/stats"
                className="flex items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <BarChart3 className="h-4 w-4" /> {t('nav.stats')}
              </Link>
              <Link
                to="/lists"
                className="flex items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <ListPlus className="h-4 w-4" /> {t('nav.lists')}
              </Link>

              <div ref={notificationsRef} className="relative">
                <button
                  ref={notificationButtonRef}
                  type="button"
                  aria-label={unreadLabel(t, unreadCount)}
                  aria-expanded={notificationsOpen}
                  aria-haspopup="true"
                  aria-controls="notification-preview"
                  onClick={() => setNotificationsOpen((open) => !open)}
                  className="relative flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-[hsl(var(--accent))]"
                  title={t('nav.notifications')}
                >
                  <Bell className="h-4 w-4" aria-hidden="true" />
                  <UnreadBadge count={unreadCount} />
                </button>

                {notificationsOpen && (
                  <section
                    id="notification-preview"
                    aria-label="Recent notifications"
                    className="absolute right-0 top-full mt-2 flex max-h-[calc(100vh-5rem)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--popover))] text-[hsl(var(--popover-foreground))] shadow-xl"
                  >
                    <div className="flex h-12 shrink-0 items-center justify-between border-b border-[hsl(var(--border))] px-4">
                      <h2 className="text-sm font-semibold">{t('nav.notifications')}</h2>
                      {unreadCount > 0 && (
                        <button
                          type="button"
                          aria-label={t('nav.markAllRead')}
                          title={t('nav.markAllRead')}
                          disabled={markAllRead.isPending}
                          onClick={() => markAllRead.mutate()}
                          className="rounded-md p-2 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                        >
                          <CheckCheck className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>

                    <div className="min-h-0 overflow-y-auto">
                      <NotificationList
                        items={notificationSummary.data?.items}
                        isLoading={notificationSummary.isLoading}
                        isError={notificationSummary.isError}
                        compact
                        onRead={(id) => markRead.mutate(id)}
                        onNavigate={() => setNotificationsOpen(false)}
                      />
                    </div>

                    <Link
                      to="/notifications"
                      onClick={() => setNotificationsOpen(false)}
                      className="block shrink-0 border-t border-[hsl(var(--border))] px-4 py-3 text-center text-sm font-medium transition-colors hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--primary))]"
                    >
                      {t('nav.viewAllNotifications')}
                    </Link>
                  </section>
                )}
              </div>

              <Link
                to={`/profile/${encodeURIComponent(user?.username ?? '')}`}
                className="flex min-w-0 items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <User className="h-4 w-4 shrink-0" />
                <span className="max-w-28 truncate lg:max-w-36">{user?.username}</span>
              </Link>
              <Link
                to="/settings"
                className="flex items-center gap-1 text-sm transition-colors hover:text-[hsl(var(--primary))]"
              >
                <Settings className="h-4 w-4" /> {t('nav.settings')}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--destructive))]"
              >
                <LogOut className="h-4 w-4" /> {t('nav.logout')}
              </button>
              <button
                type="button"
                onClick={toggle}
                className="rounded-md p-2 transition-colors hover:bg-[hsl(var(--accent))]"
                title={t('nav.toggleTheme')}
                aria-label={t('nav.toggleTheme')}
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          )}

          {!authed && (
            <div className="hidden items-center gap-4 xl:flex">
              <button
                type="button"
                onClick={toggle}
                className="rounded-md p-2 transition-colors hover:bg-[hsl(var(--accent))]"
                title={t('nav.toggleTheme')}
                aria-label={t('nav.toggleTheme')}
              >
                {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <Link to="/login" className="text-sm hover:text-[hsl(var(--primary))]">
                {t('nav.login')}
              </Link>
              <Link to="/about" className="text-sm hover:text-[hsl(var(--primary))]">
                {t('nav.about')}
              </Link>
              <Link to="/privacy" className="text-sm hover:text-[hsl(var(--primary))]">
                {t('nav.privacy')}
              </Link>
              <Link to="/terms" className="text-sm hover:text-[hsl(var(--primary))]">
                {t('nav.terms')}
              </Link>
              <Link
                to="/community-guidelines"
                className="text-sm hover:text-[hsl(var(--primary))]"
              >
                {t('nav.guidelines')}
              </Link>
              <Link
                to="/register"
                className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm text-white hover:opacity-90"
              >
                {t('nav.register')}
              </Link>
            </div>
          )}

          <div className={`flex items-center gap-1 ${authed ? 'md:hidden' : 'xl:hidden'}`}>
            {authed && (
              <>
                <Link
                  to="/notifications"
                  aria-label={unreadLabel(t, unreadCount)}
                  className="relative flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-[hsl(var(--accent))]"
                >
                  <Bell className="h-5 w-5" aria-hidden="true" />
                  <UnreadBadge count={unreadCount} />
                </Link>
                <Link
                  to="/settings"
                  aria-label={t('nav.settings')}
                  title={t('nav.settings')}
                  className="flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-[hsl(var(--accent))]"
                >
                  <Settings className="h-5 w-5" aria-hidden="true" />
                </Link>
              </>
            )}
            {!authed && (
              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-md"
                aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
                aria-expanded={mobileOpen}
                aria-controls="mobile-navigation"
                onClick={() => setMobileOpen(!mobileOpen)}
              >
                {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </button>
            )}
          </div>
        </div>

        {mobileOpen && !authed && (
          <div id="mobile-navigation" className="space-y-2 pb-4 xl:hidden">
            <button
              type="button"
              onClick={toggle}
              className="flex items-center gap-2 py-2 text-sm"
            >
              {isDark ? (
                <>
                  <Sun className="h-4 w-4" /> {t('nav.lightMode')}
                </>
              ) : (
                <>
                  <Moon className="h-4 w-4" /> {t('nav.darkMode')}
                </>
              )}
            </button>
            <Link
              to="/login"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.login')}
            </Link>
            <Link
              to="/about"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.about')}
            </Link>
            <Link
              to="/privacy"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.privacy')}
            </Link>
            <Link
              to="/terms"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.terms')}
            </Link>
            <Link
              to="/community-guidelines"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.guidelines')}
            </Link>
            <Link
              to="/register"
              className="block py-2 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {t('nav.register')}
            </Link>
          </div>
        )}
      </div>
    </nav>
  );
}
