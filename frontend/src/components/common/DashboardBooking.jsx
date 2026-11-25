import PoolCutoffEditor from './PoolCutoffEditor.jsx';
import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bookingsApi } from '../../api/client.js';
import { STATUS_LABELS } from '../../utils/bookingTimeline.js';

const CustomerVisitRoute = lazy(() => import('./CustomerVisitRoute.jsx'));

const nextAction = {
  pending: 'You can review or cancel your request in booking details.',
  confirmed: 'Check booking details for assignment updates.',
  assigned: 'Your technician has been assigned. Check back for acceptance.',
  accepted: 'Be available during your service window.',
  arrived: 'Meet your technician at the service entrance.',
  in_progress: 'Confirm completion once your visit is finished.',
};

const when = value => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function DashboardBooking() {
  const [invite, setInvite] = useState(null);
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let timer;
    async function refresh() {
      try {
        const response = await bookingsApi.dashboard();
        if (active) { setBooking(response.data); setError(''); }
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    }
    refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  if (!booking && !error) return null;
  const forming = booking?.pool?.status === 'forming';
  const completed = booking?.status === 'completed';
  async function share() {
    const url = new URL('/create-booking', window.location.origin);
    url.search = new URLSearchParams({ poolId: booking.pool.id, serviceId: booking.serviceCategoryId });
    try {
      await navigator.clipboard.writeText(url.href);
      setInvite({ id: booking.id, copied: true });
    } catch { setInvite({ id: booking.id, url: url.href }); }
  }
  return <section aria-label="Your booking" className="pool-booking">
    {error && <p role="status">Booking updates unavailable. {error}</p>}
    {booking && <>
      <h2 className="font-bold text-lg">{completed ? 'Confirm your visit' : 'Your next booking'} · {booking.service}</h2>
      <p aria-live="polite" className="font-semibold">{booking.pool && `${booking.pool.members} ${booking.pool.members === 1 ? 'member' : 'members'} · `}₹{booking.price}{booking.pool?.automaticDispatch ? ' for your visit' : booking.pool ? ' each' : ''}</p>
      {booking.closingPriceLimit != null && <p>Closing price limit · ₹{booking.closingPriceLimit}</p>}
      {forming ? <div><p>Pool forming · Joining closes {when(booking.pool.deadline)}</p>
        {booking.pool.canEditCutoff && <PoolCutoffEditor key={booking.pool.id} poolId={booking.pool.id} cutoff={booking.pool.deadline}
          serviceStart={booking.window.start} onSaved={deadline => setBooking(current => current?.pool?.id === booking.pool.id
            ? { ...current, pool: { ...current.pool, deadline } } : current)}/>}
        {booking.pool.nextPrice < booking.price && booking.pool.nextPrice != null && <p>One more neighbour brings your price to <strong>₹{booking.pool.nextPrice} each</strong>.</p>}
        {!booking.pool.automaticDispatch && <button type="button" className="pool-secondary" onClick={share}>Invite a neighbour</button>}
        {invite?.id === booking.id && (invite.copied ? <p role="status">Invitation link copied.</p> : <input aria-label="Invitation link" readOnly value={invite.url} onFocus={e => e.target.select()}/>)}
      </div> : <>
        <p>{STATUS_LABELS[booking.status]} · {when(booking.window.start)} – {when(booking.window.end)}</p>
        <p>{booking.technician ? `Technician · ${booking.technician}` : 'Awaiting technician assignment'}</p>
        {booking.visitsAhead != null && <p aria-live="polite">{booking.visitsAhead === 0 ? 'Your visit is next' : `${booking.visitsAhead} ${booking.visitsAhead === 1 ? 'visit' : 'visits'} before yours`}</p>}
        {booking.estimatedStart && <p>Estimated visit · {when(booking.estimatedStart)}</p>}
      </>}
      {booking.visitRoute && <Suspense fallback={<p>Loading visit route…</p>}>
        <CustomerVisitRoute key={booking.id} route={booking.visitRoute}/>
      </Suspense>}
      {!forming && !completed && <p className="text-sm">{nextAction[booking.status]}</p>}
      <Link className="text-emerald-700 underline" to={'/bookings/' + booking.id}>{completed ? 'Confirm completion and rate' : 'View booking'}</Link>
    </>}
  </section>;
}
