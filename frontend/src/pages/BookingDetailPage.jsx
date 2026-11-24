import PoolCutoffEditor from '../components/common/PoolCutoffEditor.jsx';
import CompletionFeedback from '../components/common/CompletionFeedback.jsx';
import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Calendar,
  Clock,
  MapPin,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Edit3,
  Trash2,
  Users,
  User,
  ShieldCheck,
} from 'lucide-react';
import { bookingsApi, poolsApi } from '../api/client.js';
import StatusBadge from '../components/common/StatusBadge.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import Modal from '../components/common/Modal.jsx';
import {
  BOOKING_STATUS_PROGRESSION,
  STATUS_LABELS,
  getBookingTimelineState,
} from '../utils/bookingTimeline.js';

export const STATUS_PROGRESSION = BOOKING_STATUS_PROGRESSION;

export default function BookingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [booking, setBooking] = useState(null);
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(location.state?.flashMessage || null);

  // Edit Modal State
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    addressText: '',
    notes: '',
    bookingMode: 'pool',
    serviceDate: '',
    startTime: '',
    endTime: '',
    coords: { lat: 22.5015, lng: 88.3531 },
  });

  // Cancel Modal State
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const fetchBooking = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await bookingsApi.getById(id);
      const data = res?.data;
      setBooking(data);

      if (data) {
        const poolIdStr = typeof data.poolId === 'object' ? data.poolId?._id : data.poolId;
        if (poolIdStr) {
          try {
            const poolRes = await poolsApi.getById(poolIdStr);
            setPool(poolRes?.data || (typeof data.poolId === 'object' ? data.poolId : null));
          } catch {
            setPool(typeof data.poolId === 'object' ? data.poolId : null);
          }
        } else {
          setPool(null);
        }
        const start = data.timeWindow?.start ? new Date(data.timeWindow.start) : new Date();
        const end = data.timeWindow?.end ? new Date(data.timeWindow.end) : new Date();
        const lat = data.location?.coordinates?.[1] ?? 22.5015;
        const lng = data.location?.coordinates?.[0] ?? 88.3531;

        // Extract local calendar date and local time consistently without UTC date slippage
        const pad = (n) => String(n).padStart(2, '0');
        const localDateStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
        const localStartTime = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
        const localEndTime = `${pad(end.getHours())}:${pad(end.getMinutes())}`;

        setEditForm({
          addressText: data.addressText || '',
          notes: data.notes || '',
          bookingMode: data.bookingMode || 'pool',
          serviceDate: localDateStr,
          startTime: localStartTime,
          endTime: localEndTime,
          coords: { lat, lng },
        });
      }
    } catch (err) {
      setError(err.message || 'Failed to load booking details.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchBooking();
  }, [fetchBooking]);

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    setError(null);

    const startDateTime = new Date(`${editForm.serviceDate}T${editForm.startTime}:00`);
    const endDateTime = new Date(`${editForm.serviceDate}T${editForm.endTime}:00`);

    if (endDateTime <= startDateTime) {
      setError('End time must be after start time.');
      return;
    }

    try {
      setEditing(true);
      await bookingsApi.update(id, {
        addressText: editForm.addressText.trim(),
        notes: editForm.notes.trim(),
        bookingMode: editForm.bookingMode,
        timeWindow: {
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString(),
        },
        location: {
          type: 'Point',
          coordinates: [editForm.coords.lng, editForm.coords.lat],
        },
      });

      setEditModalOpen(false);
      setActionSuccess('Booking details updated successfully.');
      fetchBooking();
    } catch (err) {
      setError(err.message || 'Failed to update booking.');
    } finally {
      setEditing(false);
    }
  };

  const handleConfirmCancel = async () => {
    try {
      setCancelling(true);
      await bookingsApi.cancel(id);
      setCancelModalOpen(false);
      setActionSuccess('Booking was successfully cancelled.');
      fetchBooking();
    } catch (err) {
      setError(err.message || 'Failed to cancel booking.');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return <LoadingSpinner label="Loading booking details..." size="lg" className="py-24" />;
  }

  if (!booking) {
    return (
      <div className="glass-panel rounded-2xl p-8 text-center max-w-md mx-auto my-12">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
        <h2 className="text-base font-bold text-slate-900 mb-1">Booking Not Found</h2>
        <p className="text-xs text-slate-500 mb-4">
          This booking could not be retrieved or you do not have permission to view it.
        </p>
        <button
          type="button"
          onClick={() => navigate('/bookings')}
          className="glass-button-primary text-xs mx-auto"
        >
          Return to My Bookings
        </button>
      </div>
    );
  }

  const service = booking.serviceCategoryId;
  const timelineState = getBookingTimelineState(booking.status);
  const isPending = booking.status === 'pending';
  const isCancelled = timelineState.isCancelled;
  const currentStepIndex = timelineState.currentStepIndex;
  const lat = booking.location?.coordinates?.[1] ?? 22.5015;
  const lng = booking.location?.coordinates?.[0] ?? 88.3531;

  const startDate = booking.timeWindow?.start
    ? new Date(booking.timeWindow.start).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Pending';
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Top Navigation Bar */}
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => navigate('/bookings')}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Bookings
        </button>

        <div className="flex items-center gap-2">
          {isPending && (
            <>
              {!booking.poolScope && <button
                type="button"
                onClick={() => setEditModalOpen(true)}
                className="glass-button-secondary text-xs px-3.5 py-2 font-medium"
              >
                <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                Edit Booking
              </button>}
              <button
                type="button"
                onClick={() => setCancelModalOpen(true)}
                className="p-2 rounded-xl text-rose-600 hover:bg-rose-50 border border-slate-200/80 transition-colors"
                title="Cancel booking"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {actionSuccess && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>{actionSuccess}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionSuccess(null)}
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

      {/* Main Booking Summary Header Card */}
      <div className="glass-panel rounded-3xl p-6 sm:p-8 border border-slate-200/80 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900">
                {booking.specificService || service?.name || 'Home Service'}
              </h1>
              <StatusBadge status={booking.status} />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded-full">
                {booking.bookingMode === 'pool' ? 'Service Pool' : 'Individual'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 font-mono">
              Booking Ref: {booking._id}
            </p>
          </div>

          <div className="text-left sm:text-right">
            <span className="text-2xl sm:text-3xl font-extrabold text-slate-900 block">
              ₹{booking.estimatedPrice}
            </span>
            <span className="text-[10px] text-slate-400 uppercase font-semibold">
              Estimated Rate
            </span>
          </div>
        </div>

        {booking.closingPriceLimit != null && <p className="text-sm">Your closing price limit · ₹{booking.closingPriceLimit}</p>}

        {!booking.poolScope && booking.routeSavings?.provider && (
          <p className="text-sm text-emerald-800">
            Estimated travel credit ₹{Math.min(booking.estimatedPrice, booking.routeSavings.customerPaise / 100).toFixed(2)} · Estimated total after credit ₹{Math.max(0, booking.estimatedPrice - booking.routeSavings.customerPaise / 100).toFixed(2)}
            {booking.routeSavings.provider === 'mock' && ' (simulated route)'}. This estimate is separate from the pooled booking discount.
          </p>
        )}

        {/* Status Timeline Bar (if not cancelled and recognized) */}
        {!timelineState.isCancelled && !timelineState.isUnknown && (
          <div className="py-2">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Service Fulfillment Timeline
              </p>
              <span className="text-[11px] font-medium text-slate-500">
                Current Stage:{' '}
                <strong className="text-emerald-700 font-semibold">{timelineState.currentLabel}</strong>
              </span>
            </div>
            <div className="grid grid-cols-7 gap-1 sm:gap-1.5 text-center">
              {timelineState.steps.map((step) => (
                <div key={step.key} className="space-y-1.5">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      step.isPassed
                        ? 'bg-emerald-600'
                        : 'bg-slate-200'
                    } ${step.isCurrent ? 'ring-2 ring-emerald-500/30' : ''}`}
                  />
                  <span
                    className={`block text-[9px] sm:text-[10px] leading-tight ${
                      step.isCurrent
                        ? 'font-bold text-emerald-800'
                        : step.isPassed
                        ? 'font-medium text-slate-700'
                        : 'text-slate-400'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cancelled State Presentation */}
        {timelineState.isCancelled && (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
            <div>
              <p className="font-semibold text-rose-800">Booking Cancelled</p>
              <p className="mt-0.5 text-rose-600">
                This booking has been cancelled and is no longer active. If you still require service, you may submit a new request.
              </p>
            </div>
          </div>
        )}

        {/* Unrecognized / Unknown State Safety Presentation */}
        {timelineState.isUnknown && (
          <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <p className="font-semibold text-amber-900">Status Update In Progress</p>
              <p className="mt-0.5 text-amber-700">
                The current booking status ({booking.status || 'unspecified'}) is being processed by the system.
              </p>
            </div>
          </div>
        )}
      </div>

      {booking.status === 'completed' && <CompletionFeedback key={booking._id} booking={booking} />}
      {/* Service Pool & Dynamic Pricing Card (Phase 4) */}
      {booking.bookingMode === 'pool' && pool && (
        <div className="glass-panel rounded-3xl p-6 sm:p-8 border border-emerald-200/80 bg-gradient-to-br from-emerald-50/40 via-white to-slate-50 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-emerald-100">
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                  <Users className="w-3.5 h-3.5" />
                  Service Pool Active
                </span>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                    pool.status === 'locked'
                      ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                      : 'bg-amber-100 text-amber-800 border border-amber-200'
                  }`}
                >
                  Status: {pool.status === 'forming' ? 'Forming (Open)' : pool.status}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                {pool.status === 'forming'
                  ? `Nearby neighbors within ${pool.poolRadiusKm || 2} km can join this pool to unlock higher discount tiers.`
                  : 'This pool is locked and confirmed. Technician dispatch will follow.'}
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-600 bg-white/80 px-3.5 py-2 rounded-2xl border border-slate-200 shadow-sm shrink-0">
              <Clock className="w-4 h-4 text-emerald-600" />
              <div>
                <span className="font-semibold block text-slate-800">
                  {pool.status === 'locked' ? 'Pool Finalized' : 'Lock Cutoff'}
                </span>
                <span className="text-[11px] text-slate-500 font-mono">
                  {pool.lockCutoffTime
                    ? `${new Date(pool.lockCutoffTime).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })} (${new Date(pool.lockCutoffTime).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })})`
                    : 'Pending'}
                </span>
              </div>
            </div>
          </div>

          {pool.canEditCutoff && <PoolCutoffEditor key={pool._id} poolId={pool._id} cutoff={pool.lockCutoffTime}
            serviceStart={pool.aggregateTimeWindow.start} onSaved={lockCutoffTime => setPool(current => ({ ...current, lockCutoffTime }))}/>}
          {/* Capacity Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                <Users className="w-4 h-4 text-emerald-600" />
                Pool Capacity & Formation
              </span>
              <span className="font-mono font-bold text-emerald-800">
                {pool.members?.length || 1} / {pool.maxCapacity || 4} Members Joined
              </span>
            </div>
            <div className="h-3 w-full bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    (((pool.members?.length || 1) / (pool.maxCapacity || 4)) * 100)
                  )}%`,
                }}
              />
            </div>
          </div>

          {/* Dynamic Pricing Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
              <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                Individual Base Rate
              </span>
              <span className="text-lg font-bold text-slate-800 mt-1 block">
                ₹{pool.pricing?.individualBasePrice || service?.baseIndividualPrice || booking.estimatedPrice}
              </span>
              <span className="text-[10px] text-slate-400">Standard single service</span>
            </div>

            <div className="p-4 rounded-2xl bg-emerald-50/70 border border-emerald-200/80 shadow-xs">
              <span className="text-[11px] text-emerald-800 uppercase font-semibold block">
                Pool Discount
              </span>
              <span className="text-lg font-extrabold text-emerald-700 mt-1 block">
                {pool.pricing?.discountPercentage || 0}% OFF
              </span>
              <span className="text-[10px] text-emerald-600">
                Tier for {pool.pricing?.memberCount || 1} neighbor{(pool.pricing?.memberCount || 1) > 1 ? 's' : ''}
              </span>
            </div>

            <div className="p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
              <span className="text-[11px] text-slate-400 uppercase font-semibold block">
                Your Payable Price
              </span>
              <span className="text-lg font-extrabold text-slate-900 mt-1 block">
                ₹{pool.pricing?.finalPricePerMember || booking.estimatedPrice}
              </span>
              <span className="text-[10px] text-emerald-600 font-medium">
                {pool.status === 'locked' ? 'Confirmed price' : 'Estimated pooled rate'}
              </span>
            </div>

            <div className="p-4 rounded-2xl bg-emerald-600 text-white shadow-xs">
              <span className="text-[11px] text-emerald-100 uppercase font-semibold block">
                Your Direct Savings
              </span>
              <span className="text-lg font-extrabold mt-1 block">
                ₹{pool.pricing?.totalSavingsPerMember || 0}
              </span>
              <span className="text-[10px] text-emerald-100">
                Saved by pooling together
              </span>
            </div>
          </div>

          {/* Privacy-Preserving Co-Poolers List */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              Verified Co-Pool Members (Privacy Protected)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {pool.members?.map((m, idx) => (
                <div
                  key={m._id || idx}
                  className={`p-3.5 rounded-2xl border flex items-center justify-between text-xs ${
                    m.isCurrentUser
                      ? 'bg-emerald-50/50 border-emerald-300 font-medium'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
                        m.isCurrentUser ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {m.displayName ? m.displayName[0] : 'N'}
                    </div>
                    <div>
                      <span className="font-semibold text-slate-900 block">
                        {m.displayName || 'Neighbor'} {m.isCurrentUser && '(You)'}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {m.isCurrentUser
                          ? m.addressText || 'Your Address'
                          : m.approximateAddress || 'Nearby Service Area'}
                      </span>
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {m.joinedAt
                      ? new Date(m.joinedAt).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : ''}
                  </span>
                </div>
              ))}

              {/* Show open remaining slots */}
              {Array.from({
                length: Math.max(0, (pool.maxCapacity || 4) - (pool.members?.length || 1)),
              }).map((_, i) => (
                <div
                  key={`slot-${i}`}
                  className="p-3.5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 flex items-center gap-2.5 text-xs text-slate-400"
                >
                  <div className="w-8 h-8 rounded-full border border-dashed border-slate-300 flex items-center justify-center text-slate-300 font-bold">
                    +
                  </div>
                  <span>Open slot for nearby neighbor</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Grid: Booking Specs & Map Location */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Column: Details */}
        <div className="glass-panel rounded-3xl p-6 border border-slate-200/80 space-y-5">
          <h2 className="text-sm font-bold text-slate-900 pb-2 border-b border-slate-100">
            Booking Information
          </h2>

          <div className="space-y-3.5 text-xs">
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-slate-800 block">{booking.poolScope ? 'Scheduled pool window' : 'Preferred time window'}</span>
                {booking.visitPosition && <p>Visit {booking.visitPosition} · Estimated start {new Date(booking.estimatedStart).toLocaleString()}</p>}
                <span className="text-slate-600 block mt-0.5">
                  {startDate}
                </span>
                <span className="text-slate-500 font-mono text-[11px]">
                  {startTime} to {endTime}
                </span>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-slate-800 block">Service Address</span>
                <span className="text-slate-600 block mt-0.5 leading-relaxed">
                  {booking.addressText}
                </span>
                {booking.zoneId && (
                  <span className="inline-block mt-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200/60">
                    Zone: {booking.zoneId.name} ({booking.zoneId.code})
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3">
              {booking.bookingMode === 'pool' ? (
                <Users className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <User className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              )}
              <div>
                <span className="font-semibold text-slate-800 block">Dispatch Mode</span>
                <span className="text-slate-600 block mt-0.5">
                  {booking.bookingMode === 'pool'
                    ? 'Service Pool — eligible for group discounts with compatible neighbors'
                    : 'Dedicated Individual Booking'}
                </span>
              </div>
            </div>

            {booking.notes && (
              <div className="p-3 rounded-2xl bg-slate-50 border border-slate-100 text-slate-600">
                <span className="font-semibold block text-[11px] text-slate-700 mb-0.5">
                  Customer Instructions
                </span>
                <span className="italic leading-relaxed">{booking.notes}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Location Map */}
        <div className="glass-panel rounded-3xl p-6 border border-slate-200/80 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900">Pinned Service Coordinates</h2>
            <span className="text-[11px] font-mono text-slate-400">
              {lat.toFixed(5)}, {lng.toFixed(5)}
            </span>
          </div>

          <LocationPickerMap
            value={{ lat, lng }}
            readOnly={true}
            height="260px"
          />
        </div>
      </div>

      {/* Edit Booking Modal */}
      <Modal
        isOpen={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title="Edit Pending Booking Details"
        maxWidth="max-w-xl"
      >
        <form onSubmit={handleSaveEdit} className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Service Address
            </label>
            <input
              type="text"
              required
              value={editForm.addressText}
              onChange={(e) => setEditForm({ ...editForm, addressText: e.target.value })}
              className="glass-input w-full"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">
              Adjust Location Pin on Map
            </label>
            <LocationPickerMap
              value={editForm.coords}
              onChange={(newCoords) => setEditForm({ ...editForm, coords: newCoords })}
              height="200px"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Date</label>
              <input
                type="date"
                required
                min={new Date().toISOString().split('T')[0]}
                value={editForm.serviceDate}
                onChange={(e) => setEditForm({ ...editForm, serviceDate: e.target.value })}
                className="glass-input w-full"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Start Time</label>
              <input
                type="time"
                required
                value={editForm.startTime}
                onChange={(e) => setEditForm({ ...editForm, startTime: e.target.value })}
                className="glass-input w-full"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">End Time</label>
              <input
                type="time"
                required
                value={editForm.endTime}
                onChange={(e) => setEditForm({ ...editForm, endTime: e.target.value })}
                className="glass-input w-full"
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Dispatch Mode</label>
            <select
              disabled={Boolean(booking.specificService)}
              value={editForm.bookingMode}
              onChange={(e) => setEditForm({ ...editForm, bookingMode: e.target.value })}
              className="glass-input w-full"
            >
              <option value="pool">Service Pool (Eco-friendly + Discount)</option>
              <option value="individual">Dedicated Individual</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-700 mb-1">Notes</label>
            <textarea
              rows={2}
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              className="glass-input w-full"
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
            <button
              type="button"
              disabled={editing}
              onClick={() => setEditModalOpen(false)}
              className="glass-button-secondary text-xs px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={editing}
              className="glass-button-primary text-xs px-4 py-2 font-semibold"
            >
              {editing ? 'Saving Changes...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Cancel Confirmation Modal */}
      <Modal
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="Cancel Service Booking"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-600 leading-relaxed">
            Are you sure you want to cancel this booking? This action cannot be undone.
          </p>

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
