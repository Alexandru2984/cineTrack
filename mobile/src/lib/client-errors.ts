import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { apiRequest } from '@/lib/api';
import { ApiError } from '@/lib/http';
import { hasLocalSession, useAuthStore } from '@/store/auth';

const STORAGE_KEY = 'vazute.client-errors.v1';
const MAX_QUEUED_REPORTS = 10;
const MAX_REPORT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

type ClientPlatform = 'android' | 'ios';

interface ClientErrorReport {
  error_name: string;
  message: string;
  stack?: string;
  component_stack?: string;
  platform: ClientPlatform;
  app_version: string;
  is_fatal: boolean;
  occurred_at: string;
}

interface QueuedReport {
  id: string;
  owner_id: string;
  signature: string;
  report: ClientErrorReport;
}

interface CaptureOptions {
  componentStack?: string | null;
  isFatal?: boolean;
}

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

interface NativeErrorUtils {
  getGlobalHandler?: () => GlobalErrorHandler;
  setGlobalHandler: (handler: GlobalErrorHandler) => void;
}

let storageTail: Promise<void> = Promise.resolve();
let flushPromise: Promise<void> | null = null;
const recentSignatures = new Map<string, number>();

function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storageTail.then(operation, operation);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function truncate(value: string, maxChars: number) {
  return Array.from(value).slice(0, maxChars).join('');
}

function stripUrlSecrets(value: string) {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, (rawUrl) => {
    const punctuation = rawUrl.match(/[),.;!?]+$/)?.[0] ?? '';
    const candidate = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
    try {
      const url = new URL(candidate);
      url.search = '';
      url.hash = '';
      return `${url.toString()}${punctuation}`;
    } catch {
      return '[redacted-url]';
    }
  });
}

export function sanitizeDiagnosticText(value: string, maxChars: number) {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== '\n' && character !== '\t' ? ' ' : character;
  }).join('');

  const sanitized = stripUrlSecrets(withoutControls)
    .replace(
      /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
      'Authorization: Bearer [redacted]',
    )
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      '[redacted-email]',
    )
    .replace(
      /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
      '[redacted-token]',
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]');

  return truncate(sanitized.trim(), maxChars);
}

function supportedPlatform(): ClientPlatform | null {
  return Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : null;
}

function appVersion() {
  const configured = Constants.expoConfig?.version?.trim();
  return configured && /^[A-Za-z0-9._+-]{1,32}$/.test(configured)
    ? configured
    : 'unknown';
}

function buildReport(error: unknown, options: CaptureOptions): ClientErrorReport | null {
  const platform = supportedPlatform();
  if (!platform) return null;

  const source = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : {
        name: 'NonError',
        message: typeof error === 'string' ? error : 'An unexpected error occurred',
        stack: undefined,
      };
  const errorName = sanitizeDiagnosticText(source.name || 'Error', 120) || 'Error';
  const message = sanitizeDiagnosticText(source.message, 1000) || 'An unexpected error occurred';
  const stack = source.stack ? sanitizeDiagnosticText(source.stack, 16_000) : '';
  const componentStack = options.componentStack
    ? sanitizeDiagnosticText(options.componentStack, 8_000)
    : '';

  return {
    error_name: errorName,
    message,
    ...(stack ? { stack } : {}),
    ...(componentStack ? { component_stack: componentStack } : {}),
    platform,
    app_version: appVersion(),
    is_fatal: options.isFatal ?? false,
    occurred_at: new Date().toISOString(),
  };
}

function reportSignature(report: ClientErrorReport) {
  return [
    report.error_name,
    report.message,
    report.stack?.split('\n')[0] ?? '',
    report.component_stack?.split('\n')[0] ?? '',
    String(report.is_fatal),
  ].join('\u0000');
}

function isReport(value: unknown): value is ClientErrorReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<ClientErrorReport>;
  return (
    typeof report.error_name === 'string' &&
    typeof report.message === 'string' &&
    (report.platform === 'android' || report.platform === 'ios') &&
    typeof report.app_version === 'string' &&
    typeof report.is_fatal === 'boolean' &&
    typeof report.occurred_at === 'string'
  );
}

function isQueuedReport(value: unknown): value is QueuedReport {
  if (!value || typeof value !== 'object') return false;
  const queued = value as Partial<QueuedReport>;
  return (
    typeof queued.id === 'string' &&
    typeof queued.owner_id === 'string' &&
    typeof queued.signature === 'string' &&
    isReport(queued.report)
  );
}

async function readQueueUnlocked() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Invalid report queue');
    return parsed.filter(isQueuedReport).slice(-MAX_QUEUED_REPORTS);
  } catch {
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
    return [];
  }
}

async function writeQueueUnlocked(queue: QueuedReport[]) {
  if (queue.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEY);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue.slice(-MAX_QUEUED_REPORTS)));
}

async function enqueueReport(report: ClientErrorReport, ownerId: string, signature: string) {
  await withStorageLock(async () => {
    const auth = useAuthStore.getState();
    if (!auth.user || auth.user.id !== ownerId || !hasLocalSession(auth.status)) return;
    const now = Date.now();
    const queue = (await readQueueUnlocked()).filter((queued) => {
      const occurredAt = Date.parse(queued.report.occurred_at);
      return Number.isFinite(occurredAt) && now - occurredAt <= MAX_REPORT_AGE_MS;
    });
    if (queue.some((queued) => queued.owner_id === ownerId && queued.signature === signature)) {
      return;
    }
    queue.push({
      id: `${report.occurred_at}:${Math.random().toString(36).slice(2, 10)}`,
      owner_id: ownerId,
      signature,
      report,
    });
    await writeQueueUnlocked(queue);
  });
}

async function removeQueuedReport(id: string) {
  await withStorageLock(async () => {
    const queue = await readQueueUnlocked();
    await writeQueueUnlocked(queue.filter((queued) => queued.id !== id));
  });
}

function shouldRetry(error: unknown) {
  return (
    !(error instanceof ApiError) ||
    error.status === 0 ||
    error.status === 429 ||
    error.status >= 500
  );
}

async function sendReport(report: ClientErrorReport) {
  await apiRequest('/client-errors', {
    method: 'POST',
    body: report,
  });
}

function isRecentDuplicate(signature: string) {
  const now = Date.now();
  for (const [candidate, timestamp] of recentSignatures) {
    if (now - timestamp > DEDUPE_WINDOW_MS) recentSignatures.delete(candidate);
  }
  if (recentSignatures.has(signature)) return true;
  recentSignatures.set(signature, now);
  return false;
}

export async function captureClientError(error: unknown, options: CaptureOptions = {}) {
  try {
    const auth = useAuthStore.getState();
    if (!auth.user || !hasLocalSession(auth.status)) return;
    const report = buildReport(error, options);
    if (!report) return;
    const signature = reportSignature(report);
    if (isRecentDuplicate(signature)) return;

    if (auth.status === 'authenticated') {
      try {
        await sendReport(report);
        return;
      } catch (sendError) {
        if (!shouldRetry(sendError)) return;
      }
    }

    await enqueueReport(report, auth.user.id, signature);
  } catch {
    // Error reporting must never cause another application failure.
  }
}

async function flushQueuedReports() {
  const initialAuth = useAuthStore.getState();
  if (initialAuth.status !== 'authenticated' || !initialAuth.user) return;
  const ownerId = initialAuth.user.id;
  const queue = await withStorageLock(readQueueUnlocked);

  for (const queued of queue) {
    if (queued.owner_id !== ownerId) continue;
    const auth = useAuthStore.getState();
    if (auth.status !== 'authenticated' || auth.user?.id !== ownerId) return;
    const occurredAt = Date.parse(queued.report.occurred_at);
    if (!Number.isFinite(occurredAt) || Date.now() - occurredAt > MAX_REPORT_AGE_MS) {
      await removeQueuedReport(queued.id);
      continue;
    }

    try {
      await sendReport(queued.report);
      await removeQueuedReport(queued.id);
    } catch (error) {
      if (shouldRetry(error)) return;
      await removeQueuedReport(queued.id);
    }
  }
}

export function flushClientErrorReports() {
  if (!flushPromise) {
    flushPromise = flushQueuedReports()
      .catch(() => undefined)
      .finally(() => {
        flushPromise = null;
      });
  }
  return flushPromise;
}

export function clearClientErrorReports() {
  recentSignatures.clear();
  return withStorageLock(() => AsyncStorage.removeItem(STORAGE_KEY)).catch(() => undefined);
}

export function installGlobalErrorHandler() {
  const errorUtils = (
    globalThis as typeof globalThis & { ErrorUtils?: NativeErrorUtils }
  ).ErrorUtils;
  if (!errorUtils?.getGlobalHandler) return () => undefined;

  const previousHandler = errorUtils.getGlobalHandler();
  const handler: GlobalErrorHandler = (error, isFatal) => {
    void captureClientError(error, { isFatal: Boolean(isFatal) });
    previousHandler(error, isFatal);
  };
  errorUtils.setGlobalHandler(handler);

  return () => {
    if (errorUtils.getGlobalHandler?.() === handler) {
      errorUtils.setGlobalHandler(previousHandler);
    }
  };
}
