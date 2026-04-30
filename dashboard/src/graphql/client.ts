import { Client, cacheExchange, fetchExchange } from "urql";

// in dev, vite proxies /graphql to localhost:8000
// in prod, nginx proxies /graphql to the api service
const url = import.meta.env.VITE_GRAPHQL_URL || "/graphql";

export const client = new Client({
  url,
  exchanges: [cacheExchange, fetchExchange],
  fetchOptions: {
    credentials: "include",
    method: "POST",
  },
  preferGetMethod: false,
});
