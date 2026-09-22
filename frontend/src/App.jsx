import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import Navigation from "./components/Navigation";
import Dashboard from "./components/Dashboard";
import LoginForm from "./components/LoginForm";
import MyEventRequests from "./components/MyEventRequests";
import "./App.css";

function LoadingScreen() {
  return <main className="loading-screen">Loading ConnectSphere...</main>;
}

function PagePlaceholder({ title, description }) {
  return (
    <main className="placeholder-page">
      <span className="eyebrow">ConnectSphere workspace</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </main>
  );
}

function AppRoutes() {
  const { loading, logoutMessage, clearLogoutMessage } = useAuth();

  useEffect(() => {
    if (!logoutMessage) return undefined;

    const timeout = setTimeout(clearLogoutMessage, 3500);
    return () => clearTimeout(timeout);
  }, [logoutMessage, clearLogoutMessage]);

  if (loading) return <LoadingScreen />;

  return (
    <>
      <Navigation />
      {logoutMessage && <p className="auth-success" role="status">{logoutMessage}</p>}
      <Routes>
        <Route path="/login" element={<LoginForm />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><MyEventRequests /></ProtectedRoute>} />
        <Route path="/venue-search" element={<ProtectedRoute><PagePlaceholder title="Find a venue" description="Search available venues for your next event." /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="app-shell">
          <AppRoutes />
        </div>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
