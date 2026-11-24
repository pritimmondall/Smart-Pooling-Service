import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Compass,
  CalendarPlus,
  Clock,
  Bell,
  User,
  X,
  Plus,
  Wrench,
  Activity,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useNotifications } from '../../context/NotificationContext.jsx';

const CUSTOMER_NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/services', label: 'Discover Services', icon: Compass },
  { to: '/create-booking', label: 'Book a Service', icon: CalendarPlus },
  { to: '/bookings', label: 'My Bookings', icon: Clock },
  { to: '/notifications', label: 'Notifications', icon: Bell, badge: true },
  { to: '/profile', label: 'Profile & Settings', icon: User },
];

const TECHNICIAN_NAV_ITEMS = [
  { to: '/', label: 'Technician Dashboard', icon: LayoutDashboard, end: true },
  { to: '/technician/jobs', label: 'Assigned Jobs', icon: Wrench },
  { to: '/notifications', label: 'Notifications', icon: Bell, badge: true },
  { to: '/profile', label: 'Profile & Settings', icon: User },
];

export default function Sidebar({ isOpen, onClose }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const { unreadCount } = useNotifications();
  const isTechnician = user?.role === 'technician';
  const isAdmin = user?.role === 'admin';
  const navItems = isAdmin ? [{ to: '/', label: 'Technician approvals', icon: Wrench, end: true },
    ...CUSTOMER_NAV_ITEMS.filter(item => ['/notifications','/profile'].includes(item.to))] : isTechnician ? TECHNICIAN_NAV_ITEMS : CUSTOMER_NAV_ITEMS;

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed md:sticky top-0 md:top-16 z-50 md:z-20 h-screen md:h-[calc(100vh-4rem)] w-64 glass-panel border-r border-slate-200/80 bg-white/90 md:bg-white/70 flex flex-col justify-between p-4 transition-transform duration-200 ease-in-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div>
          {/* Mobile Header */}
          <div className="flex md:hidden items-center justify-between pb-4 mb-4 border-b border-slate-100">
            <span className="font-semibold text-slate-800 text-sm">Navigation</span>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Quick Action CTA */}
          {!isAdmin && <div className="mb-6">
            {isTechnician ? (
              <NavLink
                to="/technician/jobs"
                onClick={() => onClose?.()}
                className="w-full glass-button-primary bg-[#275c47] hover:bg-[#173d36] py-2.5 px-4 text-xs font-semibold shadow-sm hover:shadow text-white flex items-center justify-center gap-2"
              >
                <Wrench className="w-4 h-4 stroke-[2.2]" />
                View Assigned Work
              </NavLink>
            ) : (
              <NavLink
                to="/create-booking"
                onClick={() => onClose?.()}
                className="w-full glass-button-primary py-2.5 px-4 text-xs font-semibold shadow-sm hover:shadow flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                New Service Booking
              </NavLink>
            )}
          </div>}

          {/* Nav Links */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={isTechnician && item.to === '/' && pathname === '/technician/dashboard' ? pathname : item.to}
                  end={item.end}
                  onClick={() => onClose?.()}
                  className={({ isActive }) =>
                    `flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all ${
                      isActive
                        ? isTechnician
                          ? 'bg-[#eaf1e9] text-[#173d36] font-semibold border border-[#d4dfd8] shadow-xs'
                          : 'bg-emerald-50 text-emerald-800 font-semibold border border-emerald-200/60 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                    }`
                  }
                >
                  <div className="flex items-center gap-3">
                    <Icon className="w-4 h-4 stroke-[1.8]" />
                    <span>{item.label}</span>
                  </div>

                  {item.badge && unreadCount > 0 && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold text-white ${
                        isTechnician ? 'bg-[#275c47]' : 'bg-emerald-600'
                      }`}
                    >
                      {unreadCount}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* Footer info card */}
        {!isAdmin && <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/60 text-[11px] text-slate-500">
          <p className="font-semibold text-slate-700">
            {isTechnician ? 'Technician Field Portal' : 'Service Pooling Mode'}
          </p>
          <p className="mt-0.5 text-slate-400 leading-snug">
            {isTechnician
              ? 'Multi-stop road route optimization, live dispatch updates, and workload capacity management.'
              : 'Save up to 30% by pooling nearby service bookings with compatible neighbors.'}
          </p>
        </div>}
      </aside>
    </>
  );
}
