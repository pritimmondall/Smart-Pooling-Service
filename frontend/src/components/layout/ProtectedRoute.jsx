import React from 'react';
import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import LoadingSpinner from '../common/LoadingSpinner.jsx';

export default function ProtectedRoute({ allowedRoles }) {
  const { user, token, isAuthenticated, loading, authError, refreshUser, logout } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <LoadingSpinner label="Authenticating session..." size="lg" />
      </div>
    );
  }

  if (token && !user && authError) return <main className="max-w-md mx-auto mt-12 p-5 space-y-4">
    <p role="alert">{authError}</p>
    <button className="glass-button-primary" onClick={refreshUser}>Retry connection</button>
    <button className="underline" onClick={logout}>Sign out</button>
  </main>;
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
