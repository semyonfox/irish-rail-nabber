import { createContext } from "react";

import type { MeUser } from "../graphql/api";

export interface AuthContextValue {
  user: MeUser | null;
  signedIn: boolean;
  loading: boolean;
  enabled: boolean;
  billingEnabled: boolean;
  error: string | null;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  manageAccount: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
