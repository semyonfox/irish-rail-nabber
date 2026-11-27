// clerk's token getter lives in react context; api and graphql clients are plain
// modules, so the auth bridge hands the getter over here
type TokenGetter = () => Promise<string | null>;

let getter: TokenGetter | null = null;

export function setTokenGetter(next: TokenGetter | null) {
  getter = next;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = getter ? await getter() : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
