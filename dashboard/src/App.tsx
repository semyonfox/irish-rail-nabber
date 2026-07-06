import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Provider } from "urql";
import { client } from "./graphql/client";
import { AuthProvider } from "./auth/AuthProvider";
import ProtectedRoute from "./auth/ProtectedRoute";
import Layout from "./components/Layout";
import LiveMap from "./pages/LiveMap";

const LoginPage = lazy(() => import("./auth/LoginPage"));
const RegisterPage = lazy(() => import("./auth/RegisterPage"));
const AccountPage = lazy(() => import("./billing/AccountPage"));
const PricingPage = lazy(() => import("./billing/PricingPage"));
const ChatAssistant = lazy(() => import("./pages/ChatAssistant"));
const Stations = lazy(() => import("./pages/Stations"));
const Analytics = lazy(() => import("./pages/Analytics"));

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <Provider value={client}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<LiveMap />} />
                <Route path="stations" element={<Stations />} />
                <Route path="login" element={<LoginPage />} />
                <Route path="register" element={<RegisterPage />} />
                <Route path="pricing" element={<PricingPage />} />
                <Route path="analytics" element={<Analytics />} />
                <Route
                  path="chat"
                  element={
                    <ProtectedRoute>
                      <ChatAssistant />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="account"
                  element={
                    <ProtectedRoute>
                      <AccountPage />
                    </ProtectedRoute>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </Provider>
  );
}
