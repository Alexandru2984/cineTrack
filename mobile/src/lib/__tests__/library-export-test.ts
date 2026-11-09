import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { apiRequest } from '@/lib/api';
import { exportAndShareLibrary, localDateStamp } from '@/lib/library-export';

const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockFile = {
  uri: 'file:///cache/vazute-library.csv',
  exists: false,
  create: mockCreate,
  write: mockWrite,
  delete: mockDelete,
};

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
  Paths: { cache: 'file:///cache' },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  apiRequest: jest.fn(),
}));

const mockApiRequest = jest.mocked(apiRequest);
const mockIsAvailable = jest.mocked(Sharing.isAvailableAsync);
const mockShare = jest.mocked(Sharing.shareAsync);

const CSV = '﻿tmdb_id,type,title\r\n372058,movie,Your Name.\r\n';

describe('library CSV export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFile.exists = false;
  });

  it('asks for the list the screen shows and shares it as a CSV', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockApiRequest.mockResolvedValueOnce(CSV);
    mockShare.mockImplementationOnce(async () => {
      mockFile.exists = true;
    });

    await exportAndShareLibrary(
      { status: 'completed', mediaType: 'movie', genre: 'anime', favorite: true, sort: 'title' },
      'ro',
    );

    const [path, options] = mockApiRequest.mock.calls[0];
    const url = new URL(path, 'https://example.test');
    expect(url.pathname).toBe('/tracking/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'completed',
      media_type: 'movie',
      genre: 'anime',
      favorite: 'true',
      sort: 'title',
      language: 'ro',
    });
    // Without it the client parses the body as JSON and the file is empty.
    expect(options).toMatchObject({ responseType: 'text' });

    expect(File).toHaveBeenCalledWith(
      'file:///cache',
      `vazute-library-${localDateStamp()}.csv`,
    );
    expect(mockWrite).toHaveBeenCalledWith(CSV);
    expect(mockShare).toHaveBeenCalledWith(mockFile.uri, {
      dialogTitle: 'Văzute library',
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('leaves no copy behind when sharing fails', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);
    mockApiRequest.mockResolvedValueOnce(CSV);
    mockCreate.mockImplementationOnce(() => {
      mockFile.exists = true;
    });
    mockShare.mockRejectedValueOnce(new Error('dismissed'));

    await expect(exportAndShareLibrary({}, 'en')).rejects.toThrow('dismissed');
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('does not ask the server when the phone cannot share a file', async () => {
    mockIsAvailable.mockResolvedValueOnce(false);

    await expect(exportAndShareLibrary({}, 'en')).rejects.toMatchObject({ status: 0 });
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('names the file after the local calendar day', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});
