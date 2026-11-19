import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, User, LogOut, Menu, X, Sparkles, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useNotifications } from '../../context/NotificationContext.jsx';

export default function Navbar({ onToggleSidebar }) {
  const { user, logout } = useAuth();
  const { notifications, unreadCount, markAsRead, fetchNotifications } = useNotifications();
  const navigate = useNavigate();

  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="sticky top-0 z-40 w-full glass-panel border-b border-slate-200/80 bg-white/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Left: Mobile Menu Toggle & Brand */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleSidebar}
            className="md:hidden p-2 rounded-xl text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Toggle navigation"
          >
            <Menu className="w-5 h-5" />
          </button>

          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-sm shadow-emerald-600/30">
              <Sparkles className="w-5 h-5 stroke-[2]" />
            </div>
            <div>
              <span className="font-semibold text-slate-900 tracking-tight text-base sm:text-lg">
                SmartPool
              </span>
              <span
                className={`hidden sm:inline-block ml-2 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                  user?.role === 'technician'
                    ? 'text-indigo-700 bg-indigo-50 border-indigo-200/60'
                    : 'text-emerald-700 bg-emerald-50 border-emerald-200/60'
                }`}
              >
                {user?.role === 'technician' ? 'Technician' : 'Customer'}
              </span>
            </div>
          </Link>
        </div>

        {/* Right: Notifications & User Menu */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Notification Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                if (!showNotifications) fetchNotifications();
                setShowNotifications(!showNotifications);
                setShowUserMenu(false);
              }}
              className="relative p-2.5 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-100/80 transition-colors"
              aria-label="Notifications"
            >
              <Bell className="w-5 h-5" />
              {unreadCount > 0 && (
                <span className="absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notification Popover Panel */}
            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 sm:w-96 glass-panel bg-white/95 rounded-2xl shadow-xl border border-slate-200 p-4 z-50">
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-2">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">Notifications</h4>
                    {unreadCount > 0 && (
                      <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded-full">
                        {unreadCount} new
                      </span>
                    )}
                  </div>
                  <Link
                    to="/notifications"
                    onClick={() => setShowNotifications(false)}
                    className="text-xs text-emerald-700 hover:text-emerald-800 font-medium"
                  >
                    View all
                  </Link>
                </div>

                <div className="max-h-72 overflow-y-auto space-y-2 py-1">
                  {notifications.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-6">
                      No notifications yet.
                    </p>
                  ) : (
                    notifications.slice(0, 5).map((n) => (
                      <div
                        key={n._id}
                        className={`p-2.5 rounded-xl border text-xs transition-all ${
                          n.isRead
                            ? 'bg-slate-50/70 border-slate-100 text-slate-600'
                            : 'bg-emerald-50/60 border-emerald-100 text-slate-900 font-medium'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-semibold text-slate-800">{n.title}</p>
                          {!n.isRead && (
                            <button
                              type="button"
                              onClick={() => markAsRead(n._id)}
                              className="text-emerald-600 hover:text-emerald-800 p-0.5"
                              title="Mark as read"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                          {n.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User Profile Menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowNotifications(false);
              }}
              className="flex items-center gap-2 p-1.5 sm:px-3 rounded-xl hover:bg-slate-100/80 transition-colors"
            >
              <div className="w-8 h-8 rounded-xl bg-slate-800 text-white font-semibold text-xs flex items-center justify-center">
                {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-xs font-semibold text-slate-800 truncate max-w-[120px]">
                  {user?.name || 'Customer'}
                </p>
                <p className="text-[10px] text-slate-400 truncate max-w-[120px]">
                  {user?.email}
                </p>
              </div>
            </button>

            {showUserMenu && (
              <div className="absolute right-0 mt-2 w-48 glass-panel bg-white/95 rounded-2xl shadow-xl border border-slate-200 p-1.5 z-50">
                <Link
                  to="/profile"
                  onClick={() => setShowUserMenu(false)}
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  <User className="w-4 h-4 text-slate-400" />
                  Account Profile
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 rounded-xl transition-colors text-left"
                >
                  <LogOut className="w-4 h-4 text-rose-400" />
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
