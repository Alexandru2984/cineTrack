import type { Dictionary } from './en';

// Typed against the English shape: TypeScript rejects this file if any key is
// missing, renamed, or extra, so RO can never drift out of sync with EN.
export const ro: Dictionary = {
  language: {
    title: 'Limbă',
    description: 'Alege limba interfeței aplicației.',
    english: 'English',
    romanian: 'Română',
  },
  nav: {
    home: 'Acasă',
    search: 'Caută',
    myList: 'Lista mea',
    library: 'Bibliotecă',
    calendar: 'Calendar',
    stats: 'Statistici',
    lists: 'Liste',
    profile: 'Profil',
    settings: 'Setări',
    logout: 'Deconectare',
    login: 'Autentificare',
    register: 'Înregistrare',
    about: 'Despre',
    privacy: 'Confidențialitate',
    notifications: 'Notificări',
    viewAllNotifications: 'Vezi toate notificările',
    markAllRead: 'Marchează tot ca citit',
    toggleTheme: 'Comută tema',
    lightMode: 'Mod luminos',
    darkMode: 'Mod întunecat',
    notificationsNoUnread: 'Notificări, nicio notificare necitită',
    notificationsUnreadOne: 'Notificări, o notificare necitită',
    notificationsUnreadMany: 'Notificări, {count} notificări necitite',
    calendarNewOne: 'Calendar, un episod nou',
    calendarNewMany: 'Calendar, {count} episoade noi',
  },
  common: {
    copy: 'Copiază',
    copied: 'Copiat',
  },
  calendarFeed: {
    title: 'Feed de calendar',
    description:
      'Abonează-te la episoadele tale viitoare în Google, Apple sau Outlook Calendar. Oricine are linkul îți poate vedea programul, așa că păstrează-l privat și regenerează-l dacă se scurge.',
    revealWarning: 'Copiază acest URL acum — pentru siguranța ta nu va mai fi afișat din nou.',
    urlLabel: 'URL feed de calendar',
    generate: 'Generează URL-ul feedului',
    regenerate: 'Regenerează URL-ul',
    disable: 'Dezactivează',
    error: 'Nu s-a putut actualiza feedul de calendar',
  },
};
