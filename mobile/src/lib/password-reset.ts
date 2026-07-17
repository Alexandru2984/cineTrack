type LinkParameter = string | string[] | undefined;

const RESET_TOKEN_PATTERN = /^[0-9a-f]{128}$/i;

function firstValue(value: LinkParameter): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function extractPasswordResetToken(
  queryToken: LinkParameter,
  fragment: LinkParameter,
): string | null {
  const queryValue = firstValue(queryToken);
  const fragmentValue = firstValue(fragment);
  const fragmentToken = fragmentValue
    ? new URLSearchParams(fragmentValue.replace(/^#/, '')).get('token')
    : null;
  const candidate = queryValue ?? fragmentToken;
  return candidate && RESET_TOKEN_PATTERN.test(candidate) ? candidate : null;
}
