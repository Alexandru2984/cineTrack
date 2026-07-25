import { Redirect } from 'expo-router';
import {
  CheckCircle2,
  FileJson,
  FileSpreadsheet,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppButton } from '@/components/app-button';
import { AppText } from '@/components/app-text';
import { ErrorState, LoadingState } from '@/components/screen-state';
import { radius, spacing } from '@/constants/theme';
import { useImportJob, useImportJobs, useStartImport } from '@/hooks/use-import';
import { useTheme } from '@/hooks/use-theme';
import { getErrorMessage } from '@/lib/http';
import {
  pickTVTimeImportFile,
  type ImportFileKind,
  type SelectedImportFile,
  type SelectedImportFiles,
} from '@/lib/import';
import { hasLocalSession, useAuthStore } from '@/store/auth';
import type { ImportJob } from '@/types';

const fileCopy: Record<
  ImportFileKind,
  { label: string; detail: string; icon: typeof FileJson }
> = {
  shows: {
    label: 'shows.json',
    detail: 'Shows and episode watch history',
    icon: FileJson,
  },
  movies: {
    label: 'movies.json',
    detail: 'Movies and ratings',
    icon: FileJson,
  },
  rewatches: {
    label: 'rewatched_episode.csv',
    detail: 'Optional GDPR rewatch history',
    icon: FileSpreadsheet,
  },
};

export default function ImportTVTimeScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const status = useAuthStore((state) => state.status);
  const online = status === 'authenticated';
  const jobs = useImportJobs(online);
  const startImport = useStartImport();
  const [files, setFiles] = useState<SelectedImportFiles>({});
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [startedJobId, setStartedJobId] = useState<string | null>(null);
  const latestJob = jobs.data?.[0] ?? null;
  const activeJobId =
    startedJobId ??
    (latestJob && (latestJob.status === 'pending' || latestJob.status === 'running')
      ? latestJob.id
      : null);
  const polledJob = useImportJob(activeJobId, online);
  const job = polledJob.data ?? latestJob;
  const completedJob = useRef<string | null>(null);

  useEffect(() => {
    if (job?.status !== 'completed' || completedJob.current === job.id) return;
    completedJob.current = job.id;
    for (const key of [
      ['tracking'],
      ['history'],
      ['stats'],
      ['calendar'],
      ['up-next'],
      ['discovery'],
    ]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [job, queryClient]);

  if (!hasLocalSession(status)) return <Redirect href="/" />;

  const choose = async (kind: ImportFileKind) => {
    setSelectionError(null);
    try {
      const selected = await pickTVTimeImportFile(kind);
      if (selected) setFiles((current) => ({ ...current, [kind]: selected }));
    } catch (error) {
      setSelectionError(getErrorMessage(error, 'The file could not be selected'));
    }
  };

  const submit = () => {
    setSelectionError(null);
    startImport.mutate(files, {
      onSuccess: ({ job_id: jobId }) => {
        setStartedJobId(jobId);
        setFiles({});
      },
    });
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.intro}>
          <View style={[styles.heroIcon, { backgroundColor: theme.primarySoft }]}>
            <UploadCloud color={theme.primary} size={30} />
          </View>
          <AppText variant="title">Import from TV Time</AppText>
          <AppText muted>
            Export your data from TV Time, then choose the files below. Parsing happens
            on Văzute and raw uploads are not retained after the job is accepted.
          </AppText>
        </View>

        {!online ? (
          <View style={[styles.notice, { borderColor: theme.warning }]}>
            <AppText variant="label" style={{ color: theme.warning }}>
              Connect to the internet to import data.
            </AppText>
          </View>
        ) : jobs.isLoading ? (
          <LoadingState label="Checking previous imports" />
        ) : jobs.isError ? (
          <ErrorState
            message={getErrorMessage(jobs.error, 'Previous imports could not be loaded')}
            onRetry={() => void jobs.refetch()}
          />
        ) : job && job.status !== 'failed' ? (
          <ImportSummary job={job} refreshing={polledJob.isFetching} />
        ) : (
          <View style={styles.form}>
            {job?.status === 'failed' ? (
              <View style={[styles.notice, { borderColor: theme.danger }]}>
                <AppText variant="label" style={{ color: theme.danger }}>
                  The previous import failed
                </AppText>
                <AppText variant="caption" muted>
                  {job.error ?? 'You can choose the files and try again.'}
                </AppText>
              </View>
            ) : null}

            {(Object.keys(fileCopy) as ImportFileKind[]).map((kind) => (
              <ImportFileRow
                key={kind}
                kind={kind}
                file={files[kind] ?? null}
                onChoose={() => void choose(kind)}
                onRemove={() =>
                  setFiles((current) => ({ ...current, [kind]: undefined }))
                }
              />
            ))}

            <AppText variant="caption" muted>
              Select at least shows.json or movies.json. Each file may be up to 16 MB
              and the combined upload may be up to 24 MB.
            </AppText>
            {selectionError || startImport.error ? (
              <AppText variant="caption" style={{ color: theme.danger }}>
                {selectionError ??
                  getErrorMessage(startImport.error, 'The import could not be started')}
              </AppText>
            ) : null}
            <AppButton
              label="Start import"
              icon={<UploadCloud color="#FFFFFF" size={18} />}
              loading={startImport.isPending}
              disabled={!online || (!files.shows && !files.movies)}
              onPress={submit}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ImportFileRow({
  kind,
  file,
  onChoose,
  onRemove,
}: {
  kind: ImportFileKind;
  file: SelectedImportFile | null;
  onChoose: () => void;
  onRemove: () => void;
}) {
  const theme = useTheme();
  const copy = fileCopy[kind];
  const Icon = copy.icon;
  return (
    <View
      style={[
        styles.fileRow,
        { borderColor: file ? theme.primary : theme.border, backgroundColor: theme.elevated },
      ]}
    >
      <Icon color={file ? theme.primary : theme.mutedText} size={22} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Choose ${copy.label}`}
        onPress={onChoose}
        style={styles.fileCopy}
      >
        <AppText variant="label">{file?.name ?? copy.label}</AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {file ? formatFileSize(file.size) : copy.detail}
        </AppText>
      </Pressable>
      {file ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${copy.label}`}
          hitSlop={8}
          onPress={onRemove}
          style={styles.removeButton}
        >
          <X color={theme.mutedText} size={20} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ImportSummary({ job, refreshing }: { job: ImportJob; refreshing: boolean }) {
  const theme = useTheme();
  const pending = job.status === 'pending' || job.status === 'running';
  const totals = job.totals;
  return (
    <View style={[styles.summary, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
      <View style={styles.summaryHeading}>
        {pending ? (
          <ActivityIndicator color={theme.primary} />
        ) : (
          <CheckCircle2 color={theme.success} size={24} />
        )}
        <View style={styles.fileCopy}>
          <AppText variant="section">
            {pending ? 'Import in progress' : 'Import complete'}
          </AppText>
          <AppText variant="caption" muted>
            {pending
              ? 'You can leave this screen; the job continues in the background.'
              : 'Your library and statistics have been refreshed.'}
          </AppText>
        </View>
        {refreshing && pending ? <Loader2 color={theme.mutedText} size={18} /> : null}
      </View>
      {totals ? (
        <>
          <View style={styles.totals}>
            <Total label="Shows" value={totals.shows} />
            <Total label="Movies" value={totals.movies} />
            <Total label="Episodes" value={totals.episodes_linked} />
            <Total label="Rewatches" value={totals.rewatches} />
            <Total label="Date-only" value={totals.episodes_date_only} />
            <Total label="Unresolved" value={totals.unresolved.length} />
          </View>
          {totals.unresolved.length ? (
            <AppText variant="caption" muted>
              Could not match: {totals.unresolved.slice(0, 8).join(', ')}
              {totals.unresolved.length > 8 ? '…' : ''}
            </AppText>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function Total({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.total}>
      <AppText variant="section">{value}</AppText>
      <AppText variant="caption" muted>{label}</AppText>
    </View>
  );
}

function formatFileSize(size: number | null) {
  if (size === null) return 'Selected';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  intro: { gap: spacing.sm },
  heroIcon: {
    width: 58,
    height: 58,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  form: { gap: spacing.md },
  notice: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  fileRow: {
    minHeight: 70,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  fileCopy: { flex: 1, gap: 2 },
  removeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summary: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  summaryHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  totals: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  total: {
    minWidth: '28%',
    flexGrow: 1,
    gap: 2,
  },
});
