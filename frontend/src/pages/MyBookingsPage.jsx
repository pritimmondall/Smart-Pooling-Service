import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock,
  Search,
  Filter,
  Calendar,
  MapPin,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Plus,
  Eye,
  Trash2,
  Edit2,
  Users,
} from 'lucide-react';
import { bookingsApi } from '../api/client.js';
import StatusBadge from '../components/common/StatusBadge.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import Modal from '../components/common/Modal.jsx';

const STATUS_TABS = [
  { id: '', label: 'All Bookings' },
  { id: 'pending', label: 'Pending Matching' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export default function MyBookingsPage() {
  const navigate = useNavigate();

  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeStatus, setActiveStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');

  // Cancel Modal State
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [bookingToCancel, setBookingToCancel] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);

  const fetchBookings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await bookingsApi.getMyBookings({
        status: activeStatus || undefined,
        limit: 50, page,
      });
      setBookings(res?.data || []);
      setPages(res.meta.pagination.pages);
    } catch (err) {
      setError(err.message || 'Failed to fetch bookings.');
    } finally {
      setLoading(false);
    }
  }, [activeStatus, page]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  const handleOpenCancelModal = (booking, e) => {
    e.stopPropagation();
    setBookingToCancel(booking);
    setCancelModalOpen(true);
  };

  const handleConfirmCancel = async () => {
    if (!bookingToCancel) return;
    try {
      setCancelling(true);
      await bookingsApi.cancel(bookingToCancel._id);
      setCancelModalOpen(false);
      setBookingToCancel(null);
      setActionMessage('Booking was successfully cancelled.');
      fetchBookings();
    } catch (err) {
      setError(err.message || 'Failed to cancel booking.');
    } finally {
      setCancelling(false);
    }
  };

  const filteredBookings = bookings.filter((b) => {
    const q = searchQuery.toLowerCase();
    const serviceName = (b.specificService || b.serviceCategoryId?.name)?.toLowerCase() || '';
    const address = b.addressText?.toLowerCase() || '';
    return serviceName.includes(q) || address.includes(q);
  });

  return (
    <div className="space-y-6">
      {/* Header & New CTA */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200/80">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <Clock className="w-6 h-6 text-emerald-600" />
            My Service Bookings
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            View, track, edit, or cancel your home service booking requests
          </p>
        </div>

        <button
          type="button"
          onClick={() => navigate('/create-booking')}
          className="glass-button-primary text-xs sm:text-sm px-4 py-2.5 font-semibold shrink-0"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          Book New Service
        </button>
      </div>

      {actionMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>{actionMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionMessage(null)}
            className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Filter Tabs & Search Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        {/* Scrollable Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {STATUS_TABS.map((tab) => {
            const isActive = activeStatus === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => { setPage(1); setActiveStatus(tab.id); }}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                  isActive
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-white/80 text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200/80'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative w-full md:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5" />
          <input
            type="text"
            placeholder="Search address or service..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="glass-input w-full pl-9 py-2 text-xs"
          />
        </div>
      </div>

      {/* Bookings List */}
      {loading ? (
        <LoadingSpinner label="Fetching your bookings..." size="lg" className="py-24" />
      ) : filteredBookings.length === 0 ? (
        <EmptyState
          title={searchQuery ? 'No matching bookings' : 'No bookings in this category'}
          description={
            searchQuery
              ? 'Try searching with a different address or service keyword.'
              : 'You do not have any bookings matching the selected status filter.'
          }
          actionLabel={activeStatus ? 'Clear Filters' : 'Create a Service Booking'}
          onAction={() => {
            if (activeStatus || searchQuery) {
              setPage(1);
              setActiveStatus('');
              setSearchQuery('');
            } else {
              navigate('/create-booking');
            }
          }}
        />
      ) : (
        <div className="space-y-3.5">
          {filteredBookings.map((booking) => {
            const serviceName = booking.specificService || booking.serviceCategoryId?.name || 'Home Service';
            const startDate = booking.timeWindow?.start
              ? new Date(booking.timeWindow.start).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Date Pending';
            const startTime = booking.timeWindow?.start
              ? new Date(booking.timeWindow.start).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
            const endTime = booking.timeWindow?.end
              ? new Date(booking.timeWindow.end).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';

            const isPending = booking.status === 'pending';

            return (
              <div
                key={booking._id}
                onClick={() => navigate(`/bookings/${booking._id}`)}
                className="glass-card rounded-2xl p-5 border border-slate-200/80 cursor-pointer hover:border-slate-300 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
              >
                {/* Booking Info */}
                <div className="space-y-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h3 className="font-bold text-slate-900 text-sm sm:text-base truncate">
                      {serviceName}
                    </h3>
                    <StatusBadge status={booking.status} />
                    {booking.bookingMode === 'pool' ? (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        Pool {booking.poolId?.status ? `(${booking.poolId.status})` : ''}
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                        Individual
                      </span>
                    )}
                    {booking.poolId?.pricing?.discountPercentage > 0 && (
                      <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded">
                        {booking.poolId.pricing.discountPercentage}% OFF
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-500 pt-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{booking.addressText}</span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>
                        {startDate} ({startTime} - {endTime})
                      </span>
                    </div>
                  </div>

                  {booking.notes && (
                    <p className="text-[11px] text-slate-400 line-clamp-1 italic pt-0.5">
                      &ldquo;{booking.notes}&rdquo;
                    </p>
                  )}
                </div>

                {/* Price and Actions */}
                <div className="flex items-center justify-between md:justify-end gap-3 pt-3 md:pt-0 border-t md:border-t-0 border-slate-100 shrink-0">
                  <div className="text-left md:text-right">
                    <span className="text-base font-extrabold text-slate-900 block">
                      ₹{booking.estimatedPrice}
                    </span>
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">
                      Estimated
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/bookings/${booking._id}`);
                      }}
                      className="glass-button-secondary text-xs px-3 py-2 font-medium"
                      title="View details"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Details</span>
                    </button>

                    {isPending && (
                      <button
                        type="button"
                        onClick={(e) => handleOpenCancelModal(booking, e)}
                        className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 transition-colors"
                        title="Cancel booking"
                        aria-label="Cancel booking"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pages > 1 && <nav aria-label="Booking history pages" className="flex items-center gap-4">
        <button disabled={loading || page === 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span>
        <button disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </nav>}
      {/* Cancel Confirmation Modal */}
      <Modal
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="Cancel Pending Service Booking"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            Are you sure you want to cancel this booking for{' '}
            <strong className="text-slate-900">
              {bookingToCancel?.specificService || bookingToCancel?.serviceCategoryId?.name || 'Home Service'}
            </strong>{' '}
            at <span className="text-slate-800">{bookingToCancel?.addressText}</span>?
          </p>

          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-[11px]">
            This request has not been dispatched yet and will be safely marked as cancelled.
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
            <button
              type="button"
              disabled={cancelling}
              onClick={() => setCancelModalOpen(false)}
              className="glass-button-secondary text-xs px-4 py-2"
            >
              Keep Booking
            </button>
            <button
              type="button"
              disabled={cancelling}
              onClick={handleConfirmCancel}
              className="glass-button-primary bg-rose-600 hover:bg-rose-700 text-white text-xs px-4 py-2 font-semibold"
            >
              {cancelling ? 'Cancelling...' : 'Confirm Cancellation'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
