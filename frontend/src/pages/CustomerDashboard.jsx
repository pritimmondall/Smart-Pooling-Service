import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, House, LocateFixed, MapPin, Plus, Radio, UsersRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import useNearbyPools from '../components/common/useNearbyPools.js';

import DashboardBooking from '../components/common/DashboardBooking.jsx';
import DashboardPoolMatcher from '../components/common/DashboardPoolMatcher.jsx';

import './CustomerDashboard.css';

const fallbackLocation = { lat: 22.5015, lng: 88.3531 };

export default function CustomerDashboard() {
  const { user, syncContactProfile, updateProfile } = useAuth();
  const saved = user?.poolAlertLocation?.coordinates;
  const [location, setLocation] = useState(() => saved ? { lat: saved[1], lng: saved[0] } : null);
  const [rangeMeters, setRangeMeters] = useState(saved ? 200 : 1000);
  const [editingLocation, setEditingLocation] = useState(!saved);
  const picked = useRef(false);
  const chooseLocation = point => { picked.current = true; setLocation(point); };
  useEffect(() => {
    if (saved) {
      if (!picked.current) {
        setLocation({ lat: saved[1], lng: saved[0] });
        setEditingLocation(false);
      }
    } else {
      syncContactProfile().catch(() => {});
    }
  }, [saved, syncContactProfile]);
  const [savingPin, setSavingPin] = useState(false);
  const [address, setAddress] = useState('');
  const [finding, setFinding] = useState(false);
  const [locating, setLocating] = useState(false);
  const [lookup, setLookup] = useState('');
  const { items, error, loading } = useNearbyPools({ ...(location || fallbackLocation), radiusKm: rangeMeters / 1000 });

  async function savePin() {
    setSavingPin(true);
    try {
      await updateProfile({ poolAlertLocation: location });
      setLookup('Location saved for nearby pools and invitations.');
    } catch (err) { setLookup(err.message || 'Could not save your location.'); }
    finally { setSavingPin(false); }
  }

  async function findAddress() {
    setFinding(true);
    setLookup('');
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: address, format: 'jsonv2', limit: 1 })}`);
      if (!response.ok) throw new Error();
      const [place] = await response.json();
      if (!place) throw new Error();
      chooseLocation({ lat: Number(place.lat), lng: Number(place.lon) });
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
      chooseLocation({ lat: position.coords.latitude, lng: position.coords.longitude });
      setLocating(false);
      setLookup('Searching from your current location.');
    }, () => {
      setLocating(false);
      setLookup('Location access was unavailable. Choose your location on the map.');
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  const radius = rangeMeters < 1000 ? `${rangeMeters} m` : '1 km';
  return <div className="pool-home">
    <header className="pool-hero">
      <div className="pool-hero-copy">
        <p className="pool-date">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p>
        <h1>Your neighbourhood<br/><em>service pools.</em></h1>
        <p>Find a shared visit and compare your price before booking.</p>
      </div>
      <div className="pool-map-art" aria-hidden="true">
        <div className="pool-map-grid"/><div className="pool-map-radius"/>
        <span className="map-house map-house-one"><House/></span>
        <span className="map-house map-house-two"><House/></span>
        <span className="map-centre"><MapPin/></span>
      </div>
    </header>
    <DashboardBooking />
    <div className="pool-workspace">
    <DashboardPoolMatcher location={location}>
      <div className="pool-location">
        <MapPin aria-hidden="true" size={18}/><div>
        <strong>Service location</strong>
        <p>{location ? `${saved && location.lat === saved[1] && location.lng === saved[0] ? 'Saved pin' : 'Selected pin'} · ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'Choose where you need service'}</p></div>
        <button type="button" aria-expanded={editingLocation} className="pool-location-edit" onClick={() => setEditingLocation(open => !open)}>
          {editingLocation ? 'Close' : 'Change'}
        </button>

      </div>
      {!editingLocation && lookup && <p role="status" className="text-sm">{lookup}</p>}
      {editingLocation && <div className="space-y-3 border rounded-xl p-4">
        <button type="button" className="pool-current" disabled={locating} onClick={useCurrentLocation}><LocateFixed size={16}/>{locating ? 'Finding your location…' : 'Use my current location'}</button>
        <label className="block text-sm font-medium">Street address or landmark
          <input className="glass-input w-full mt-1" value={address} onChange={event => setAddress(event.target.value)} maxLength={300} placeholder="Search for a service location" />
        </label>
        <button type="button" className="glass-button-secondary px-4 py-2" disabled={!address.trim() || finding} onClick={findAddress}>{finding ? 'Searching…' : 'Find address on map'}</button>
        {lookup && <p role="status" className="text-sm">{lookup}</p>}
        <LocationPickerMap value={location || fallbackLocation} onChange={chooseLocation} height="260px" />
        {location && (location.lat !== saved?.[1] || location.lng !== saved?.[0]) && <button type="button"
          className="glass-button-secondary" disabled={savingPin} onClick={savePin}>{savingPin ? 'Saving…' : 'Save pin for nearby pools and invitations'}</button>}
        {saved && <button type="button" className="text-sm text-emerald-700 underline" onClick={() => setLocation({ lat: saved[1], lng: saved[0] })}>Use saved alert location</button>}
      </div>}
    </DashboardPoolMatcher>
    <section className="pool-panel pool-nearby">
      <div className="pool-section-heading"><span className="pool-icon"><Radio/></span><h2>{location ? 'Nearby pools' : 'Pools near Jadavpur'}</h2></div>
      <label className="pool-range">Search radius <strong>{radius}</strong>
        <input type="range" min="100" max="1000" step="50" value={rangeMeters} onChange={event => setRangeMeters(Number(event.target.value))} />
      </label>
      {loading && <p role="status">Finding nearby pools…</p>}
      {error && <p role="alert">{error}</p>}
      {!location && <p className="pool-empty">Browsing around Green Park / Jadavpur. Choose your service location to search your area and check whether you can join.</p>}
      {!loading && !error && items?.length === 0 && <div className="pool-empty"><Radio aria-hidden="true"/><h3>No open pools within {radius}</h3><p>Widen your search or start a pool for your preferred service.</p></div>}
      {items?.map(pool => <article key={pool.id} className="pool-offer">
        <h3>{pool.name}</h3>
        <p><MapPin size={14}/>{pool.distanceMeters} m {location ? 'from your pin' : 'from the preview centre'} · {pool.area}</p>
        <p><UsersRound size={14}/>{pool.members}/{pool.capacity} booked</p>
        <div className="pool-offer-price"><del>₹{pool.individualPrice}</del> <strong>₹{pool.price} if you join</strong></div>
        <p className="pool-saving">Save ₹{pool.savings} ({pool.discountPercentage}%)</p>
        <small>{pool.members + 1} members including you after joining</small>
        {location && pool.canJoinFromLocation === false ? <p>Outside this pool’s joining area.</p> :
          <Link className="pool-join" to={`/create-booking?${new URLSearchParams({ poolId: pool.id, serviceId: pool.serviceCategoryId, ...(location && { lat: String(location.lat), lng: String(location.lng) }) })}`}>{location ? 'Join pool' : 'Check joining area'} <ArrowUpRight size={16}/></Link>}
      </article>)}
      <Link className="pool-custom" to="/create-booking"><Plus size={16}/> Create a pool with a custom area</Link>
    </section>
    </div>
  </div>;
}
