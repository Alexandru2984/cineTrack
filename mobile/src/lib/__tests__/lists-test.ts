import {
  LIST_DESCRIPTION_MAX_LENGTH,
  LIST_NAME_MAX_LENGTH,
  listInputFromDraft,
} from '@/lib/lists';

describe('mobile custom list helpers', () => {
  it('normalizes a valid list draft', () => {
    expect(listInputFromDraft('  Weekend movies  ', '  Friday night.  ', true)).toEqual({
      input: {
        name: 'Weekend movies',
        description: 'Friday night.',
        is_public: true,
      },
      error: null,
    });
  });

  it('rejects blank and oversized values', () => {
    expect(listInputFromDraft('   ', '', false).input).toBeNull();
    expect(listInputFromDraft('x'.repeat(LIST_NAME_MAX_LENGTH + 1), '', false).input).toBeNull();
    expect(
      listInputFromDraft('Valid', 'x'.repeat(LIST_DESCRIPTION_MAX_LENGTH + 1), false).input,
    ).toBeNull();
  });
});
