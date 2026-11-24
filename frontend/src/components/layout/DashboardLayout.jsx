import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import Navbar from './Navbar.jsx';
import Sidebar from './Sidebar.jsx';

export default function DashboardLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { user } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => {
    const page = { '/technician/jobs': 'Assigned jobs', '/technician/profile-setup': 'Technician work profile',
      '/profile': 'Profile', '/notifications': 'Notifications', '/bookings': 'My bookings', '/create-booking': 'Book a service',
      '/services': 'Services' }[pathname] || (pathname.startsWith('/bookings/') ? 'Booking details' :
      { technician: 'Technician dashboard', customer: 'Customer dashboard', admin: 'Technician approvals' }[user.role]);
    document.title = 'SmartPool — ' + page;
    return () => { document.title = 'SmartPool'; };
  }, [pathname, user.role]);

  return (
    <div className="min-h-screen flex flex-col bg-[#f8fafc]">
      <Navbar onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      <div className="flex-1 max-w-7xl w-full mx-auto flex">
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto max-w-full">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
