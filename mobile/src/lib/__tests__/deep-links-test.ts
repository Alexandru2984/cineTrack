import {
  episodePath,
  mediaPath,
  profilePath,
  publicUrl,
  safePostAuthRedirect,
} from '@/lib/deep-links';

describe('mobile deep links', () => {
  const episodeId = '9f73ec5d-27bc-44a0-ae8f-8c43384eff3a';

  it('builds web URLs that map directly to native routes', () => {
    expect(publicUrl(mediaPath(1396, 'tv'))).toBe(
      'https://vazute.micutu.com/media/1396?type=tv',
    );
    expect(publicUrl(episodePath(episodeId))).toBe(
      `https://vazute.micutu.com/episodes/${episodeId}`,
    );
    expect(publicUrl(profilePath('alex_984'))).toBe(
      'https://vazute.micutu.com/profile/alex_984',
    );
  });

  it.each([
    '/media/1396?type=tv',
    '/media/550?type=movie',
    `/episodes/${episodeId}`,
    '/profile/alex_984',
  ])('accepts the canonical protected destination %s', (value) => {
    expect(safePostAuthRedirect(value)).toBe(value);
  });

  it.each([
    'https://evil.example/media/1?type=tv',
    '//evil.example/path',
    '/media/1?type=person',
    '/media/2147483648?type=movie',
    '/media/1?type=tv&next=https://evil.example',
    '/episodes/not-a-uuid',
    '/profile/a',
    '/profile/alex%2Fsettings',
    '/settings',
    '/media\\1?type=tv',
    '/media/1?type=tv\n/evil',
  ])('rejects an unsafe or unsupported redirect %s', (value) => {
    expect(safePostAuthRedirect(value)).toBeNull();
  });

  it('rejects missing, duplicated, and oversized redirect parameters', () => {
    expect(safePostAuthRedirect(undefined)).toBeNull();
    expect(safePostAuthRedirect([])).toBeNull();
    expect(safePostAuthRedirect(['/media/1?type=tv', '/profile/alex'])).toBeNull();
    expect(safePostAuthRedirect(`/profile/${'a'.repeat(300)}`)).toBeNull();
  });
});
