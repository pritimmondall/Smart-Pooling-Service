import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, CalendarPlus } from 'lucide-react';
import useNearbyPools from '../components/common/useNearbyPools.js';

export default function CustomerDashboard() {
  const { items, error, loading, needsLocation } = useNearbyPools({});
  return <main className="space-y-6 max-w-4xl mx-auto">
    <section className="glass-panel rounded-3xl p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><MapPin className="text-emerald-600"/>Pools within 200 m</h1>
      {loading && <p>Finding nearby pools…</p>}
      {error && <p role="alert">{error}</p>}
      {needsLocation ? <Link className="text-emerald-700 underline" to="/profile">Set your location to find nearby pools</Link>
        : items?.length === 0 && <p>No open pools near your saved location yet.</p>}
      {items?.map(pool => <article key={pool.id} className="border rounded-xl p-4 flex items-center justify-between gap-3">
        <div><h2 className="font-semibold">{pool.name}</h2><p className="text-sm">{pool.distanceMeters} m away · {pool.area} · {pool.members}/{pool.capacity} booked · ₹{pool.price} each after joining</p></div>
        <Link className="glass-button-primary px-4 py-2" to={`/create-booking?poolId=${pool.id}&serviceId=${pool.serviceCategoryId}`}>Join pool</Link>
      </article>)}
    </section>
    <section className="glass-panel rounded-3xl p-6 space-y-3">
      <h2 className="font-bold text-xl flex items-center gap-2"><CalendarPlus className="text-emerald-600"/>Manual booking</h2>
      <p>Choose a service to start a pool or book an individual visit.</p>
      <Link className="glass-button-primary px-4 py-2" to="/create-booking">Choose a service</Link>
    </section>
  </main>;
}
