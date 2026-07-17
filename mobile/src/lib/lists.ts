export const LIST_NAME_MAX_LENGTH = 200;
export const LIST_DESCRIPTION_MAX_LENGTH = 1000;

export interface ListInput {
  name: string;
  description: string;
  is_public: boolean;
}

export function listInputFromDraft(
  name: string,
  description: string,
  isPublic: boolean,
): { input: ListInput; error: null } | { input: null; error: string } {
  const normalizedName = name.trim();
  const normalizedDescription = description.trim();
  if (!normalizedName) {
    return { input: null, error: 'List name cannot be blank.' };
  }
  if (normalizedName.length > LIST_NAME_MAX_LENGTH) {
    return { input: null, error: `List name must be at most ${LIST_NAME_MAX_LENGTH} characters.` };
  }
  if (normalizedDescription.length > LIST_DESCRIPTION_MAX_LENGTH) {
    return {
      input: null,
      error: `Description must be at most ${LIST_DESCRIPTION_MAX_LENGTH} characters.`,
    };
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
