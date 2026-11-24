import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { NotificationProvider } from './context/NotificationContext.jsx';
import ProtectedRoute from './components/layout/ProtectedRoute.jsx';
import DashboardLayout from './components/layout/DashboardLayout.jsx';

import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import TechnicianApprovals from './pages/TechnicianApprovals.jsx';
import CustomerDashboard from './pages/CustomerDashboard.jsx';
import TechnicianProfileSetup from './pages/TechnicianProfileSetup.jsx';
import TechnicianDashboard from './pages/TechnicianDashboard.jsx';
import ServicesPage from './pages/ServicesPage.jsx';
import CreateBookingPage from './pages/CreateBookingPage.jsx';
import MyBookingsPage from './pages/MyBookingsPage.jsx';
import BookingDetailPage from './pages/BookingDetailPage.jsx';
import NotificationsPage from './pages/NotificationsPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';

function RoleBasedOverview() {
  const { user } = useAuth();
  if (user?.role === 'admin') return <TechnicianApprovals />;
  if (user?.role === 'technician') {
    return <TechnicianDashboard />;
  }
  return <CustomerDashboard />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NotificationProvider>
          <Routes>
            {/* Public Auth Routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* Protected Dashboard Routes */}
            <Route element={<ProtectedRoute />}>
              <Route element={<DashboardLayout />}>
                {/* Shared Overview Route (renders role-appropriate dashboard) */}
                <Route path="/" element={<RoleBasedOverview />} />

                {/* Technician-Only Routes */}
                <Route element={<ProtectedRoute allowedRoles={['technician']} />}>
                  <Route path="/technician/dashboard" element={<TechnicianDashboard />} />
                  <Route path="/technician/profile-setup" element={<TechnicianProfileSetup />} />
                  <Route path="/technician/jobs" element={<TechnicianDashboard />} />
                </Route>

                {/* Customer-Only Routes */}
                <Route element={<ProtectedRoute allowedRoles={['customer']} />}>
                  <Route path="/services" element={<ServicesPage />} />
                  <Route path="/create-booking" element={<CreateBookingPage />} />
                  <Route path="/bookings" element={<MyBookingsPage />} />
                  <Route path="/bookings/:id" element={<BookingDetailPage />} />
                </Route>

                {/* Shared User Profile & Notifications */}
                <Route path="/notifications" element={<NotificationsPage />} />
                <Route path="/profile" element={<ProfilePage />} />
              </Route>
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
