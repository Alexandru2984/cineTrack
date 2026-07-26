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
