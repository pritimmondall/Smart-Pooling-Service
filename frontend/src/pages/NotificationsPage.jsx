import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  CheckCircle2,
  Calendar,
  Sparkles,
  Inbox,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { useNotifications } from '../context/NotificationContext.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import EmptyState from '../components/common/EmptyState.jsx';

export default function NotificationsPage() {
  const { notifications, loading, markAsRead, fetchNotifications } = useNotifications();
  const [filterUnread, setFilterUnread] = useState(false);

  const displayedNotifications = filterUnread
    ? notifications.filter((n) => !n.isRead)
    : notifications;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200/80">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <Bell className="w-6 h-6 text-emerald-600" />
            In-App Notifications
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Status updates regarding your service requests and pool matching progress
          </p>
        </div>

        {/* Filter Toggle */}
        <div className="flex items-center gap-1.5 bg-white/80 p-1 rounded-xl border border-slate-200/80 shrink-0">
          <button
            type="button"
            onClick={() => setFilterUnread(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              !filterUnread
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All ({notifications.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterUnread(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filterUnread
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Unread ({notifications.filter((n) => !n.isRead).length})
          </button>
        </div>
      </div>

      {loading && notifications.length === 0 ? (
        <LoadingSpinner label="Loading notifications..." size="lg" className="py-24" />
      ) : displayedNotifications.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={filterUnread ? 'No unread notifications' : 'Your inbox is clear'}
          description={
            filterUnread
              ? 'You have caught up with all your notifications.'
              : 'Updates regarding your bookings and pooling dispatches will appear here.'
          }
          actionLabel={filterUnread ? 'View All' : 'Refresh'}
          onAction={filterUnread ? () => setFilterUnread(false) : fetchNotifications}
        />
      ) : (
        <div className="space-y-3">
          {displayedNotifications.map((n) => {
            const timeAgo = n.createdAt
              ? new Date(n.createdAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';

            return (
              <div
                key={n._id}
                className={`glass-panel rounded-2xl p-4 sm:p-5 border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                  n.isRead
                    ? 'bg-white/60 border-slate-200/70 text-slate-600'
                    : 'bg-emerald-50/40 border-emerald-200/70 text-slate-900 shadow-xs'
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">{n.title}</span>
                    {!n.isRead && (
                      <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                    )}
                  </div>

                  <p className="text-xs text-slate-600 leading-relaxed max-w-xl">
                    {n.message}
                  </p>

                  <div className="flex items-center gap-2 text-[11px] text-slate-400 pt-1">
                    <Clock className="w-3 h-3" />
                    <span>{timeAgo}</span>
                    {n.relatedEntityId && (
                      <>
                        <span>•</span>
                        <Link
                          to={n.role === 'technician' ? (['pool', 'opportunity'].includes(n.type) ? `/technician/dashboard?work=${n.relatedEntityId}` : '/technician/dashboard') : n.invitation?.serviceCategoryId ? `/create-booking?${new URLSearchParams({
                            ...(n.invitation.automaticDispatch ? { service: n.invitation.specificService } : { poolId: n.relatedEntityId }),
                            serviceId: n.invitation.serviceCategoryId,
                            start: n.invitation.start, end: n.invitation.end,
                            ...(n.invitation.fromWatch && { watch: 1, lat: n.invitation.lat, lng: n.invitation.lng }),
                          })}` : `/bookings/${n.relatedEntityId}`}
                          className="font-medium text-emerald-700 hover:text-emerald-800 flex items-center gap-1"
                        >
                          {n.role === 'technician' ? (n.type === 'pool' ? 'View pool' : 'View work') : n.invitation?.serviceCategoryId ? 'Review booking options' : 'View Related Booking'} <ExternalLink className="w-3 h-3" />
                        </Link>
                      </>
                    )}
                  </div>
                </div>

                {!n.isRead && (
                  <button
                    type="button"
                    onClick={() => markAsRead(n._id)}
                    className="glass-button-secondary text-xs px-3 py-1.5 self-start sm:self-auto shrink-0"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Mark Read
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
