import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { bookingsApi } from '../../api/client.js';
import { STATUS_LABELS } from '../../utils/bookingTimeline.js';

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
  return <section aria-label="Your booking" className="pool-booking">
    {error && <p role="status">Booking updates unavailable. {error}</p>}
    {booking && <>
      <h2 className="font-bold text-lg">{completed ? 'Confirm your visit' : 'Your next booking'} · {booking.service}</h2>
      <p aria-live="polite" className="font-semibold">{booking.pool && `${booking.pool.members} ${booking.pool.members === 1 ? 'member' : 'members'} · `}₹{booking.price}{booking.pool ? ' each' : ''}</p>
      {forming ? <p>Pool forming · Joining closes {when(booking.pool.deadline)}</p> : <>
        <p>{STATUS_LABELS[booking.status]} · {when(booking.window.start)} – {when(booking.window.end)}</p>
        <p>{booking.technician ? `Technician · ${booking.technician}` : 'Awaiting technician assignment'}</p>
        {booking.estimatedStart && <p>Estimated visit · {when(booking.estimatedStart)}</p>}
      </>}
      {!forming && !completed && <p className="text-sm">{nextAction[booking.status]}</p>}
      <Link className="text-emerald-700 underline" to={'/bookings/' + booking.id}>{completed ? 'Confirm completion and rate' : 'View booking'}</Link>
    </>}
  </section>;
}
