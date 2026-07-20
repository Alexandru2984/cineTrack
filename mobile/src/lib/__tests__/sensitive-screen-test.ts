import { shouldConceal } from '@/hooks/use-sensitive-screen';

describe('shouldConceal', () => {
  it('hides a secret the moment the app stops being active', () => {
    // iOS takes its app-switcher snapshot during 'inactive', so waiting for
    // 'background' would let the recovery codes into that cached image.
    expect(shouldConceal(true, 'inactive')).toBe(true);
    expect(shouldConceal(true, 'background')).toBe(true);
  });

  it('shows the secret while the user is actually looking at it', () => {
    expect(shouldConceal(true, 'active')).toBe(false);
  });

  it('does nothing when there is no secret on screen', () => {
    expect(shouldConceal(false, 'inactive')).toBe(false);
    expect(shouldConceal(false, 'background')).toBe(false);
    expect(shouldConceal(false, 'active')).toBe(false);
  });
});
