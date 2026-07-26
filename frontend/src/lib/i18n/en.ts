// English is the source of truth for the app's UI copy. Every other locale is
// typed against this shape (see ./ro.ts), so a missing or misspelled key is a
// compile error rather than a silent fallback. Add new strings here first.
export const en = {
  language: {
    title: 'Language',
    description: 'Choose the language for the app interface.',
    english: 'English',
    romanian: 'Română',
  },
  nav: {
    home: 'Home',
    search: 'Search',
    myList: 'My List',
    library: 'Library',
    calendar: 'Calendar',
    stats: 'Stats',
    lists: 'Lists',
    profile: 'Profile',
    settings: 'Settings',
    logout: 'Logout',
    login: 'Login',
    register: 'Register',
    about: 'About',
    privacy: 'Privacy',
    notifications: 'Notifications',
    viewAllNotifications: 'View all notifications',
    markAllRead: 'Mark all as read',
    toggleTheme: 'Toggle theme',
    lightMode: 'Light Mode',
    darkMode: 'Dark Mode',
    notificationsNoUnread: 'Notifications, no unread notifications',
    notificationsUnreadOne: 'Notifications, 1 unread notification',
    notificationsUnreadMany: 'Notifications, {count} unread notifications',
    calendarNewOne: 'Calendar, 1 new episode',
    calendarNewMany: 'Calendar, {count} new episodes',
  },
  common: {
    copy: 'Copy',
    copied: 'Copied',
  },
  calendarFeed: {
    title: 'Calendar feed',
    description:
      'Subscribe to your upcoming episodes in Google, Apple, or Outlook Calendar. Anyone with the link can see your schedule, so keep it private and regenerate it if it ever leaks.',
    revealWarning: "Copy this URL now — for your security it won't be shown again.",
    urlLabel: 'Calendar feed URL',
    generate: 'Generate feed URL',
    regenerate: 'Regenerate URL',
    disable: 'Disable',
    error: 'Could not update the calendar feed',
  },
};

export type Dictionary = typeof en;
