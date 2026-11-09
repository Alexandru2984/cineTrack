import { afterEach, describe, expect, it, vi } from 'vitest';

import { localDateStamp, saveFile } from '@/lib/download';

describe('saveFile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads through a temporary link and releases the address later', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:vazute/1');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('library.csv');
      expect(this.href).toBe('blob:vazute/1');
    });

    saveFile(new Blob(['a,b']), 'library.csv');

    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:vazute/1');
  });

  it('stamps files with the local date', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
