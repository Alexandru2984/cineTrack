import { useMutation } from '@tanstack/react-query';

import type { LibraryFilters } from '@/hooks/use-tracking';
import { exportAndShareLibrary } from '@/lib/library-export';

/** The library as a CSV, handed to the share sheet. No password: it is the
 *  same data the library screen already shows. */
export function useExportLibrary() {
  return useMutation({
    mutationFn: ({ filters, language }: { filters: LibraryFilters; language: string }) =>
      exportAndShareLibrary(filters, language),
  });
}
