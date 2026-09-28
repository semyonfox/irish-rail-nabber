import type { CombinedError } from "urql";

// identifies an expired or missing Clerk session
export function isAuthError(error: CombinedError | null | undefined) {
  if (!error) return false;
  if (error.response?.status === 401) return true;
  return error.graphQLErrors.some((item) => /authentication required/i.test(item.message));
}
