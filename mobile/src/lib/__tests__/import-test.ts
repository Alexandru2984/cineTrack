import * as DocumentPicker from 'expo-document-picker';

import { apiFormDataRequest, apiRequest } from '@/lib/api';
import { ApiError } from '@/lib/http';
import {
  listTVTimeImportJobs,
  pickTVTimeImportFile,
  startTVTimeImport,
  validateTVTimeImportFiles,
} from '@/lib/import';

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('@/lib/api', () => ({
  apiFormDataRequest: jest.fn(),
  apiRequest: jest.fn(),
}));

const mockPicker = jest.mocked(DocumentPicker.getDocumentAsync);
const mockMultipartRequest = jest.mocked(apiFormDataRequest);
const mockApiRequest = jest.mocked(apiRequest);

describe('TV Time mobile import', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts only the expected export filename and forwards no file contents', async () => {
    mockPicker.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///private/cache/shows.json',
          name: 'shows.json',
          size: 1_024,
          mimeType: 'application/json',
          lastModified: 0,
        },
      ],
    });

    await expect(pickTVTimeImportFile('shows')).resolves.toEqual({
      uri: 'file:///private/cache/shows.json',
      name: 'shows.json',
      size: 1_024,
      mimeType: 'application/json',
    });
    expect(mockPicker).toHaveBeenCalledWith({
      type: '*/*',
      multiple: false,
      copyToCacheDirectory: true,
    });
  });

  it('rejects mismatched names and oversized files before upload', async () => {
    mockPicker
      .mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///private/cache/not-shows.json',
            name: 'not-shows.json',
            size: 100,
            mimeType: 'application/json',
            lastModified: 0,
          },
        ],
      })
      .mockResolvedValueOnce({
        canceled: false,
        assets: [
          {
            uri: 'file:///private/cache/shows.json',
            name: 'shows.json',
            size: 16 * 1024 * 1024 + 1,
            mimeType: 'application/json',
            lastModified: 0,
          },
        ],
      });

    await expect(pickTVTimeImportFile('shows')).rejects.toBeInstanceOf(ApiError);
    await expect(pickTVTimeImportFile('shows')).rejects.toMatchObject({
      status: 400,
      message: 'shows.json must be 16 MB or smaller',
    });
  });

  it('requires a title file and enforces the combined upload limit', () => {
    expect(() => validateTVTimeImportFiles({})).toThrow(
      'Choose shows.json or movies.json to start an import',
    );
    expect(() =>
      validateTVTimeImportFiles({
        shows: {
          uri: 'file:///shows.json',
          name: 'shows.json',
          mimeType: 'application/json',
          size: 16 * 1024 * 1024,
        },
        movies: {
          uri: 'file:///movies.json',
          name: 'movies.json',
          mimeType: 'application/json',
          size: 9 * 1024 * 1024,
        },
      }),
    ).toThrow('The selected files must total 24 MB or less');
  });

  it('starts a multipart job and validates the returned identifier', async () => {
    mockMultipartRequest.mockResolvedValueOnce({
      job_id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
    });

    await expect(
      startTVTimeImport({
        shows: {
          uri: 'file:///private/cache/shows.json',
          name: 'shows.json',
          mimeType: 'application/json',
          size: 1_024,
        },
      }),
    ).resolves.toEqual({
      job_id: '7d7acbc0-a064-4cb0-a3ea-6c41caa62bc3',
    });
    expect(mockMultipartRequest).toHaveBeenCalledWith(
      '/import/tvtime',
      expect.any(FormData),
    );
  });

  it('rejects malformed job payloads from the server', async () => {
    mockApiRequest.mockResolvedValueOnce([
      {
        id: 'not-a-uuid',
        status: 'completed',
        totals: null,
        error: null,
        created_at: '2026-07-25T00:00:00Z',
        updated_at: '2026-07-25T00:00:00Z',
      },
    ]);

    await expect(listTVTimeImportJobs()).rejects.toThrow();
  });
});
