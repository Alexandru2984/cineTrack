// English is the source of truth for the mobile UI copy. Other locales are
// typed against this shape (see ./ro.ts), so a missing or renamed key is a
// compile error. Add new strings here first.
export const en = {
  language: {
    title: 'Language',
    description: 'Choose the language for the app interface.',
    english: 'English',
    romanian: 'Română',
  },
  nav: {
    home: 'Home',
    calendar: 'Calendar',
    search: 'Search',
    library: 'Library',
    profile: 'Profile',
  },
  calendarFeed: {
    title: 'Calendar feed',
    subtitle: 'Subscribe to upcoming episodes.',
    description:
      'Add your upcoming episodes to any calendar app. Anyone with the link can see your schedule, so keep it private and regenerate it if it ever leaks.',
    revealWarning: "Share or save this link now — for your security it won't be shown again.",
    share: 'Share link',
    generate: 'Generate feed URL',
    regenerate: 'Regenerate URL',
    disable: 'Disable',
    error: 'Could not update the calendar feed',
  },
};

export type Dictionary = typeof en;
