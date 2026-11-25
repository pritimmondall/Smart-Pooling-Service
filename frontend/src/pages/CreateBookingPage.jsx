import React, { useState, useEffect, useRef } from 'react';
import { LocateFixed, MapPin } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';

import { useSearchParams } from 'react-router-dom';
import DashboardPoolMatcher from '../components/common/DashboardPoolMatcher.jsx';

import './CustomerDashboard.css';

const fallbackLocation = { lat: 22.5015, lng: 88.3531 };

export default function CreateBookingPage() {
  const { user, syncContactProfile, updateProfile } = useAuth();
  const [params] = useSearchParams();
  const saved = user?.poolAlertLocation?.coordinates;
  const [location, setLocation] = useState(() => saved ? { lat: saved[1], lng: saved[0] } : null);
  const [editingLocation, setEditingLocation] = useState(false);
  const picked = useRef(false);
  const [pinAddress, setPinAddress] = useState('');
  const chooseLocation = point => { setPinAddress(''); picked.current = true; setLocation(point); };
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

  async function savePin() {
    setSavingPin(true);
    try {
      await updateProfile({ poolAlertLocation: location });
      setLookup('Service location saved.');
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
      setPinAddress(address.trim());
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

  return <div className="pool-home">
    <header className="visit-heading"><h1>Book a home visit</h1><p>Choose your service, address and preferred time. We’ll arrange the technician.</p></header>
    <DashboardPoolMatcher location={location} params={params} address={pinAddress}>
      <div className="pool-location">
        <MapPin aria-hidden="true" size={18}/><div>
        <strong>Service location</strong>
        <p>{location ? `${saved && location.lat === saved[1] && location.lng === saved[0] ? 'Saved pin' : 'Selected pin'} · ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'Choose where you need service'}</p></div>
        <button type="button" aria-expanded={editingLocation} className="pool-location-edit" onClick={() => setEditingLocation(open => !open)}>
          {editingLocation ? 'Done' : location ? 'Change' : 'Choose location'}
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
          className="glass-button-secondary" disabled={savingPin} onClick={savePin}>{savingPin ? 'Saving…' : 'Save location'}</button>}
        {saved && <button type="button" className="text-sm text-emerald-700 underline" onClick={() => chooseLocation({ lat: saved[1], lng: saved[0] })}>Use saved location</button>}
      </div>}
    </DashboardPoolMatcher>
  </div>;
}
