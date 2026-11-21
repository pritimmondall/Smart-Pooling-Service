import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, CalendarPlus } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import useNearbyPools from '../components/common/useNearbyPools.js';

const fallbackLocation = { lat: 22.5015, lng: 88.3531 };

export default function CustomerDashboard() {
  const { user } = useAuth();
  const saved = user?.poolAlertLocation?.coordinates;
  const [location, setLocation] = useState(() => saved ? { lat: saved[1], lng: saved[0] } : null);
  const [editingLocation, setEditingLocation] = useState(false);
  const [address, setAddress] = useState('');
  const [finding, setFinding] = useState(false);
  const [lookup, setLookup] = useState('');
  const { items, error, loading } = useNearbyPools(location);

  async function findAddress() {
    setFinding(true);
    setLookup('');
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: address, format: 'jsonv2', limit: 1 })}`);
      if (!response.ok) throw new Error();
      const [place] = await response.json();
      if (!place) throw new Error();
      setLocation({ lat: Number(place.lat), lng: Number(place.lon) });
      setLookup(`${place.display_name} · © OpenStreetMap contributors`);
    } catch {
      setLookup('Address lookup failed. Choose the location on the map instead.');
    } finally {
      setFinding(false);
    }
  }

  return <main className="space-y-6 max-w-4xl mx-auto">
    <section className="glass-panel rounded-3xl p-6 space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><MapPin className="text-emerald-600"/>Pools within 200 m</h1>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p>{location ? `Searching near ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${saved && location.lat === saved[1] && location.lng === saved[0] ? ' (saved alert location)' : ''}` : 'Choose where you want service to find nearby pools.'}</p>
        <button type="button" className="text-emerald-700 underline" onClick={() => setEditingLocation(open => !open)}>
          {editingLocation ? 'Hide location picker' : 'Change search location'}
        </button>
      </div>
      {editingLocation && <div className="space-y-3 border rounded-xl p-4">
        <label className="block text-sm font-medium">Street address or landmark
          <input className="glass-input w-full mt-1" value={address} onChange={event => setAddress(event.target.value)} maxLength={300} placeholder="Search for a service location" />
        </label>
        <button type="button" className="glass-button-secondary px-4 py-2" disabled={!address.trim() || finding} onClick={findAddress}>{finding ? 'Searching…' : 'Find address on map'}</button>
        {lookup && <p role="status" className="text-sm">{lookup}</p>}
        <LocationPickerMap value={location || fallbackLocation} onChange={setLocation} height="260px" />
        {saved && <button type="button" className="text-sm text-emerald-700 underline" onClick={() => setLocation({ lat: saved[1], lng: saved[0] })}>Use saved alert location</button>}
      </div>}
      {location && loading && <p>Finding nearby pools…</p>}
      {error && <p role="alert">{error}</p>}
      {!location && <p>Select a location on the map to search for pools.</p>}
      {location && !loading && !error && items?.length === 0 && <p>No open pools within 200 m of this location. Try the service address or entrance used by the pool creator.</p>}
      {items?.map(pool => <article key={pool.id} className="border rounded-xl p-4 flex items-center justify-between gap-3">
        <div><h2 className="font-semibold">{pool.name}</h2><p className="text-sm">{pool.distanceMeters} m away · {pool.area} · {pool.members}/{pool.capacity} booked · ₹{pool.price} each after joining</p></div>
        <Link className="glass-button-primary px-4 py-2" to={`/create-booking?${new URLSearchParams({ poolId: pool.id, serviceId: pool.serviceCategoryId, lat: String(location.lat), lng: String(location.lng) })}`}>Join pool</Link>
      </article>)}
      <p className="text-xs text-slate-500">Same-building pools also require the matching building or apartment block when joining.</p>
    </section>
    <section className="glass-panel rounded-3xl p-6 space-y-3">
      <h2 className="font-bold text-xl flex items-center gap-2"><CalendarPlus className="text-emerald-600"/>Manual booking</h2>
      <p>Choose a service to start a pool or book an individual visit.</p>
      <Link className="glass-button-primary px-4 py-2" to="/create-booking">Choose a service</Link>
    </section>
  </main>;
}
