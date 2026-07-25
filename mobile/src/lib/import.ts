import * as DocumentPicker from 'expo-document-picker';
import { z } from 'zod';

import { apiMultipartRequest, apiRequest } from '@/lib/api';
import { ApiError } from '@/lib/http';
import type { ImportJob } from '@/types';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export type ImportFileKind = 'shows' | 'movies' | 'rewatches';

export interface SelectedImportFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number | null;
}

export type SelectedImportFiles = Partial<
  Record<ImportFileKind, SelectedImportFile>
>;

const expectedNames: Record<ImportFileKind, string> = {
  shows: 'shows.json',
  movies: 'movies.json',
  rewatches: 'rewatched_episode.csv',
};

const totalsSchema = z.object({
  shows: z.number().int().nonnegative(),
  movies: z.number().int().nonnegative(),
  episodes_linked: z.number().int().nonnegative(),
  episodes_date_only: z.number().int().nonnegative(),
  rewatches: z.number().int().nonnegative(),
  unresolved: z.array(z.string().max(200)).max(5_000),
});

const importJobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  totals: totalsSchema.nullable(),
  error: z.string().max(500).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

function importFileError(kind: ImportFileKind, name: string) {
  return `Choose the ${expectedNames[kind]} file, not ${name || 'an unnamed file'}`;
}

export async function pickTVTimeImportFile(
  kind: ImportFileKind,
): Promise<SelectedImportFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset || asset.name.toLowerCase() !== expectedNames[kind]) {
    throw new ApiError(importFileError(kind, asset?.name ?? ''), 400);
  }
  if (asset.size !== undefined && asset.size > MAX_FILE_BYTES) {
    throw new ApiError(`${asset.name} must be 16 MB or smaller`, 400);
  }

  return {
    uri: asset.uri,
    name: asset.name,
    mimeType:
      asset.mimeType ??
      (kind === 'rewatches' ? 'text/csv' : 'application/json'),
    size: asset.size ?? null,
  };
}

export function validateTVTimeImportFiles(files: SelectedImportFiles) {
  if (!files.shows && !files.movies) {
    throw new ApiError('Choose shows.json or movies.json to start an import', 400);
  }
  const knownTotal = Object.values(files).reduce(
    (total, file) => total + (file?.size ?? 0),
    0,
  );
  if (knownTotal > MAX_UPLOAD_BYTES) {
    throw new ApiError('The selected files must total 24 MB or less', 400);
  }
}

export async function startTVTimeImport(files: SelectedImportFiles) {
  validateTVTimeImportFiles(files);
  const form = new FormData();
  for (const kind of ['shows', 'movies', 'rewatches'] as const) {
    const file = files[kind];
    if (!file) continue;
    form.append(
      kind,
      {
        uri: file.uri,
        name: file.name,
        type: file.mimeType,
      } as unknown as Blob,
    );
  }
  const payload = await apiMultipartRequest<unknown>('/import/tvtime', form);
  return z.object({ job_id: z.string().uuid() }).parse(payload);
}

export async function listTVTimeImportJobs(): Promise<ImportJob[]> {
  const payload = await apiRequest<unknown>('/import/jobs');
  return z.array(importJobSchema).max(20).parse(payload) as ImportJob[];
}

export async function getTVTimeImportJob(jobId: string): Promise<ImportJob> {
  const payload = await apiRequest<unknown>(`/import/jobs/${jobId}`);
  return importJobSchema.parse(payload) as ImportJob;
}
