import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import useNearbyPools from '../components/common/useNearbyPools.js';

import DashboardBooking from '../components/common/DashboardBooking.jsx';
import DashboardPoolMatcher from '../components/common/DashboardPoolMatcher.jsx';

const fallbackLocation = { lat: 22.5015, lng: 88.3531 };

export default function CustomerDashboard() {
  const { user } = useAuth();
  const saved = user?.poolAlertLocation?.coordinates;
  const [location, setLocation] = useState(() => saved ? { lat: saved[1], lng: saved[0] } : null);
  const [rangeMeters, setRangeMeters] = useState(200);
  const [editingLocation, setEditingLocation] = useState(false);
  const [address, setAddress] = useState('');
  const [finding, setFinding] = useState(false);
  const [locating, setLocating] = useState(false);
  const [lookup, setLookup] = useState('');
  const { items, error, loading } = useNearbyPools(location ? { ...location, radiusKm: rangeMeters / 1000 } : null);

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

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setLookup('This browser cannot provide your current location. Choose it on the map.');
      return;
    }
    setLocating(true);
    setLookup('');
    navigator.geolocation.getCurrentPosition(position => {
      setLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
      setLocating(false);
      setLookup('Searching from your current location.');
    }, () => {
      setLocating(false);
      setLookup('Location access was unavailable. Choose your location on the map.');
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  return <main className="space-y-6 max-w-4xl mx-auto">
    <DashboardBooking />
    <DashboardPoolMatcher location={location}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <p>{location ? `Searching near ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${saved && location.lat === saved[1] && location.lng === saved[0] ? ' (saved alert location)' : ''}` : 'Choose where you want service to find nearby pools.'}</p>
        <button type="button" className="text-emerald-700 underline" onClick={() => setEditingLocation(open => !open)}>
          {editingLocation ? 'Hide location picker' : 'Change search location'}
        </button>
        <button type="button" className="text-emerald-700 underline" disabled={locating} onClick={useCurrentLocation}>{locating ? 'Finding your location…' : 'Use my current location'}</button>
      </div>
      {!editingLocation && lookup && <p role="status" className="text-sm">{lookup}</p>}
      {editingLocation && <div className="space-y-3 border rounded-xl p-4">
        <label className="block text-sm font-medium">Street address or landmark
          <input className="glass-input w-full mt-1" value={address} onChange={event => setAddress(event.target.value)} maxLength={300} placeholder="Search for a service location" />
        </label>
        <button type="button" className="glass-button-secondary px-4 py-2" disabled={!address.trim() || finding} onClick={findAddress}>{finding ? 'Searching…' : 'Find address on map'}</button>
        {lookup && <p role="status" className="text-sm">{lookup}</p>}
        <LocationPickerMap value={location || fallbackLocation} onChange={setLocation} height="260px" />
        {saved && <button type="button" className="text-sm text-emerald-700 underline" onClick={() => setLocation({ lat: saved[1], lng: saved[0] })}>Use saved alert location</button>}
      </div>}
    </DashboardPoolMatcher>
    <section className="glass-panel rounded-3xl p-6 space-y-4">
      <h2 className="text-xl font-bold flex items-center gap-2"><MapPin className="text-emerald-600"/>Nearby pools</h2>
      <label className="block text-sm font-medium max-w-sm">Search range: {rangeMeters < 1000 ? `${rangeMeters} m` : '1 km'}
        <input type="range" className="w-full mt-2 accent-emerald-600" min="100" max="1000" step="50" value={rangeMeters} onChange={event => setRangeMeters(Number(event.target.value))} />
        <span className="flex justify-between text-xs text-slate-500"><span>100 m</span><span>1 km</span></span>
      </label>
      {location && loading && <p>Finding nearby pools…</p>}
      {error && <p role="alert">{error}</p>}
      {!location && <p>Select a location on the map to search for pools.</p>}
      {location && !loading && !error && items?.length === 0 && <p>No open pools within {rangeMeters < 1000 ? `${rangeMeters} m` : '1 km'} of this location. Try another service location or a larger range.</p>}
      {items?.map(pool => <article key={pool.id} className="border rounded-xl p-4 flex items-center justify-between gap-3">
        <div><h2 className="font-semibold">{pool.name}</h2><p className="text-sm">{pool.distanceMeters} m away · {pool.area} joining area · {pool.members}/{pool.capacity} booked</p>
          <p>Individual ₹{pool.individualPrice} · <strong>₹{pool.price} if you join</strong> · save ₹{pool.savings} ({pool.discountPercentage}%)</p>
          <p className="text-sm">{pool.members + 1} members including you after joining</p>
          {pool.canJoinFromLocation === false && <p className="text-sm text-amber-700">Visible in your search range; choose a service location within this pool's joining area to join.</p>}
        </div>
        {pool.canJoinFromLocation !== false && <Link className="glass-button-primary px-4 py-2" to={`/create-booking?${new URLSearchParams({ poolId: pool.id, serviceId: pool.serviceCategoryId, lat: String(location.lat), lng: String(location.lng) })}`}>Join pool</Link>}
      </article>)}
      <p className="text-xs text-slate-500">Your search range includes pools in your apartment area and other buildings. Joining depends on the pool's distance limit.</p>
    </section>
    <Link className="inline-block text-emerald-700 underline" to="/create-booking">Create a pool with a specific joining area</Link>
  </main>;
}
