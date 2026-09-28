import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import GraphqlProvider from "./graphql/GraphqlProvider";
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
const Buses = lazy(() => import("./pages/Buses"));
const Analytics = lazy(() => import("./pages/Analytics"));
const History = lazy(() => import("./pages/History"));

function RouteFallback() {
  return <div className="empty h-full">Loading…</div>;
}
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <GraphqlProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<LiveMap />} />
                <Route path="stations" element={<Stations />} />
                <Route path="buses" element={<Buses />} />
                <Route path="buses/stops" element={<Buses view="stops" />} />
                <Route path="buses/network" element={<Buses view="network" />} />
                {/* clerk walks multi-step flows under these paths */}
                <Route path="login/*" element={<LoginPage />} />
                <Route path="register/*" element={<RegisterPage />} />
                <Route path="pricing" element={<PricingPage />} />
                <Route
                  path="analytics"
                  element={
                    <ProtectedRoute requirePaid>
                      <Analytics />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="history"
                  element={
                    <ProtectedRoute requirePaid>
                      <History />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="chat"
                  element={
                    <ProtectedRoute requirePaid>
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
        </GraphqlProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
