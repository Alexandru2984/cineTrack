export const LIST_NAME_MAX_LENGTH = 200;
export const LIST_DESCRIPTION_MAX_LENGTH = 1000;

export interface ListInput {
  name: string;
  description: string;
  is_public: boolean;
}

/** A locale-agnostic validation failure; the caller resolves it to a localized
 *  message (see the `listEditor.error*` keys). */
export type ListDraftError =
  | { code: 'nameBlank' }
  | { code: 'nameTooLong'; max: number }
  | { code: 'descriptionTooLong'; max: number };

export function listInputFromDraft(
  name: string,
  description: string,
  isPublic: boolean,
): { input: ListInput; error: null } | { input: null; error: ListDraftError } {
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  if (!normalizedName) {
    return { input: null, error: { code: 'nameBlank' } };
  }
  if (normalizedName.length > LIST_NAME_MAX_LENGTH) {
    return { input: null, error: { code: 'nameTooLong', max: LIST_NAME_MAX_LENGTH } };
  }
  if (normalizedDescription.length > LIST_DESCRIPTION_MAX_LENGTH) {
    return { input: null, error: { code: 'descriptionTooLong', max: LIST_DESCRIPTION_MAX_LENGTH } };
  }
  return {
    input: {
      name: normalizedName,
      description: normalizedDescription,
      is_public: isPublic,
    },
    error: null,
  };
}
