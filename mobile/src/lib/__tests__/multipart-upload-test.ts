import { ApiError, rawMultipartRequest } from '@/lib/http';

const mockUpload = jest.fn();

jest.mock('expo-file-system', () => ({
  File: function () {
    return { upload: (...args: unknown[]) => mockUpload(...args) };
  },
  UploadType: { MULTIPART: 'multipart' },
}));

const file = {
  uri: 'file:///cache/ImageManipulator/prepared.jpg',
  fieldName: 'avatar',
  mimeType: 'image/jpeg',
};

describe('native multipart upload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('parses a successful response', async () => {
    mockUpload.mockResolvedValueOnce({
      status: 200,
      body: '{"avatar_url":"https://vazute.micutu.com/a.jpg"}',
      headers: {},
    });

    await expect(rawMultipartRequest('/users/me/avatar', file)).resolves.toEqual({
      avatar_url: 'https://vazute.micutu.com/a.jpg',
    });
  });

  it('reports the server message on a rejected upload', async () => {
    mockUpload.mockResolvedValueOnce({
      status: 400,
      body: '{"message":"Avatar image must be 3 MB or smaller"}',
      headers: {},
    });

    await expect(rawMultipartRequest('/users/me/avatar', file)).rejects.toMatchObject({
      status: 400,
      message: 'Avatar image must be 3 MB or smaller',
    });
  });

  // The whole point of moving off fetch. A native failure knows why it failed,
  // and burying that behind a connection message is what made this bug take
  // weeks: every log was empty because the reason was never in a log.
  it('shows why the upload failed instead of blaming the connection', async () => {
    mockUpload.mockRejectedValueOnce(new Error('File does not exist'));

    const error: unknown = await rawMultipartRequest('/users/me/avatar', file).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.message).toBe('The upload failed: File does not exist');
    expect((apiError.cause as Error).message).toBe('File does not exist');
  });

  it('falls back to the connection message when there is no reason to show', async () => {
    mockUpload.mockRejectedValueOnce('not an error');

    await expect(rawMultipartRequest('/users/me/avatar', file)).rejects.toMatchObject({
      message: 'Could not connect to Văzute',
    });
  });

  // The signal has to reach the native task. Checking it around the call would
  // leave the transfer running after a sign-out, with only the promise
  // abandoned — a cancellation the tests claimed but the app did not perform.
  it('cancels the native task when the caller aborts mid-upload', async () => {
    const controller = new AbortController();
    let forwarded: AbortSignal | undefined;
    mockUpload.mockImplementationOnce(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          forwarded = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );

    const pending = rawMultipartRequest('/users/me/avatar', file, {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(forwarded?.aborted).toBe(false);

    controller.abort();
    expect(forwarded?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ message: 'The request was cancelled' });
  });

  it('reports a cancelled upload as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    mockUpload.mockRejectedValueOnce(new Error('Aborted'));

    await expect(
      rawMultipartRequest('/users/me/avatar', file, { signal: controller.signal }),
    ).rejects.toMatchObject({ message: 'The request was cancelled', status: 0 });
  });

  // The fetch path had a 60 second ceiling. Moving to a native uploader removed
  // it, leaving an upload able to hang for as long as the platform allowed.
  it('aborts an upload that runs past the timeout', async () => {
    jest.useFakeTimers();
    mockUpload.mockImplementationOnce(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );

    const pending = rawMultipartRequest('/users/me/avatar', file);
    jest.advanceTimersByTime(60_000);

    await expect(pending).rejects.toMatchObject({
      message: 'The request timed out',
      status: 0,
    });
  });
});
