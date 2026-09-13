import { Client, cacheExchange, fetchExchange } from "urql";

import { authHeaders } from "../auth/token";

// in dev, vite proxies /graphql to localhost:8001
// in prod, nginx proxies /graphql to the api service
const url = import.meta.env.VITE_GRAPHQL_URL || "/graphql";

export function createClient() {
  return new Client({
    url,
    exchanges: [cacheExchange, fetchExchange],
    fetchOptions: {
      credentials: "include",
      method: "POST",
    },
    // attach the clerk session token to every request
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await authHeaders())) {
        headers.set(name, value);
      }
      return fetch(input, { ...init, headers });
    },
    preferGetMethod: false,
  });
}
