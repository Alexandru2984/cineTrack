import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { libraryParams, type LibraryFilters } from '@/hooks/use-tracking';
import { apiRequest } from '@/lib/api';
import { ApiError, withQuery } from '@/lib/http';

/** Today's date as the phone's calendar has it, for the file name. */
export function localDateStamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The library as the screen shows it — filters and order — as a CSV handed to
 *  the share sheet: Files, Drive, Sheets, mail. */
export async function exportAndShareLibrary(filters: LibraryFilters, language: string) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new ApiError('File sharing is not available on this device', 0);
  }

  const file = new File(Paths.cache, `vazute-library-${localDateStamp()}.csv`);
  if (file.exists) file.delete();

  const contents = await apiRequest<string>(
    withQuery('/tracking/export', { ...libraryParams(filters), language }),
    { responseType: 'text', timeoutMs: 60_000 },
  );
  try {
    file.create({ overwrite: true });
    file.write(contents);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: 'Văzute library',
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
    });
  } finally {
    // The receiving app keeps its own copy; the cache keeps none.
    if (file.exists) file.delete();
  }
}
