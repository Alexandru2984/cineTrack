import type { Dictionary } from './en';

// Typed against the English shape, so RO cannot drift out of sync with EN.
export const ro: Dictionary = {
  language: {
    title: 'Limbă',
    description: 'Alege limba interfeței aplicației.',
    english: 'English',
    romanian: 'Română',
  },
  calendarFeed: {
    title: 'Feed de calendar',
    subtitle: 'Abonează-te la episoadele viitoare.',
    description:
      'Adaugă episoadele tale viitoare în orice aplicație de calendar. Oricine are linkul îți poate vedea programul, așa că păstrează-l privat și regenerează-l dacă se scurge.',
    revealWarning: 'Distribuie sau salvează linkul acum — pentru siguranța ta nu va mai fi afișat.',
    share: 'Distribuie linkul',
    generate: 'Generează URL-ul feedului',
    regenerate: 'Regenerează URL-ul',
    disable: 'Dezactivează',
    error: 'Nu s-a putut actualiza feedul de calendar',
  },
};
