import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Provider } from "urql";
import { client } from "./graphql/client";
import { AuthProvider } from "./auth/AuthProvider";
import LoginPage from "./auth/LoginPage";
import ProtectedRoute from "./auth/ProtectedRoute";
import RegisterPage from "./auth/RegisterPage";
import AccountPage from "./billing/AccountPage";
import PricingPage from "./billing/PricingPage";
import Layout from "./components/Layout";
import LiveMap from "./pages/LiveMap";
import Stations from "./pages/Stations";
import Analytics from "./pages/Analytics";

export default function App() {
  return (
    <Provider value={client}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<LiveMap />} />
              <Route path="stations" element={<Stations />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="pricing" element={<PricingPage />} />
              <Route
                path="analytics"
                element={
                  <ProtectedRoute>
                    <Analytics />
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
        </AuthProvider>
      </BrowserRouter>
    </Provider>
  );
}
