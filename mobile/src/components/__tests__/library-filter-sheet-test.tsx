import { fireEvent, render, screen } from '@testing-library/react-native';

import { LibraryFilterSheet } from '@/components/library-filter-sheet';
import type { TrackingFacets } from '@/types';

jest.mock('@/hooks/use-t', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
// The icon package ships ES modules only; an icon is nothing these tests read.
jest.mock('lucide-react-native', () => ({ Check: () => null, Download: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View };
});

const facets: TrackingFacets = {
  total: 4,
  statuses: { completed: 4 },
  media_types: { movie: 1, tv: 3 },
  genres: [{ id: 16, name: 'Animation', count: 4 }],
  anime: 2,
  favorites: 1,
};

function renderSheet(props: Partial<Parameters<typeof LibraryFilterSheet>[0]> = {}) {
  return render(
    <LibraryFilterSheet
      visible
      filters={{ genre: 'anime' }}
      facets={facets}
      onChange={jest.fn()}
      onClear={jest.fn()}
      onClose={jest.fn()}
      {...props}
    />,
  );
}

// The first render pulls Modal, ScrollView and Switch through Babel, which took
// 11 s on a cold cache here — past Jest's 5 s default, though nothing hangs.
// CI always starts cold.
jest.setTimeout(30_000);

describe('LibraryFilterSheet export', () => {
  it('exports the list behind the sheet', async () => {
    const onExport = jest.fn();
    await renderSheet({ onExport });

    await fireEvent.press(screen.getByText('library.exportCsv'));

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.getByText('library.exportCsvHint')).toBeTruthy();
  });

  it('shows why an export failed', async () => {
    await renderSheet({ onExport: jest.fn(), exportError: 'Could not export your library' });

    expect(screen.getByText('Could not export your library')).toBeTruthy();
  });

  it('offers nothing to export when no title matches', async () => {
    const onExport = jest.fn();
    await renderSheet({ onExport, facets: { ...facets, total: 0 } });

    await fireEvent.press(screen.getByText('library.exportCsv'));

    expect(onExport).not.toHaveBeenCalled();
  });

  it('has no export action unless the screen gives one', async () => {
    await renderSheet();

    expect(screen.queryByText('library.exportCsv')).toBeNull();
  });
});
