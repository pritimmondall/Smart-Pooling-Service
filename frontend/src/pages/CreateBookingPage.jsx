import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { servicesApi, bookingsApi, userApi } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import useNearbyPools from '../components/common/useNearbyPools.js';

const panel = 'glass-panel rounded-3xl p-6 space-y-4';
const input = 'glass-input w-full';
function localInput(date) {
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0,16);
}

export default function CreateBookingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invited = params.get('poolId');
  const invitedLat = Number(params.get('lat'));
  const invitedLng = Number(params.get('lng'));
  const invitedLocation = params.has('lat') && params.has('lng') && Number.isFinite(invitedLat) && Number.isFinite(invitedLng)
    && Math.abs(invitedLat) <= 90 && Math.abs(invitedLng) <= 180
    ? { lat: invitedLat, lng: invitedLng } : null;
  const [catalog, setCatalog] = useState([]);
  const [scopes, setScopes] = useState({});
  const [domain, setDomain] = useState('');
  const [specific, setSpecific] = useState('');
  const [mode, setMode] = useState('pool');
  const [scope, setScope] = useState('200m');
  const [building, setBuilding] = useState('');
  const [choice, setChoice] = useState('');
  const targetId = invited || choice;
  const saved = user?.poolAlertLocation?.coordinates;
  const [coords, setCoords] = useState(invitedLocation || { lat: saved?.[1] ?? 22.5015, lng: saved?.[0] ?? 88.3531 });
  const locationEdited = useRef(Boolean(invitedLocation));
  useEffect(() => {
    if (saved) return;
    let active = true;
    userApi.getProfile().then(res => {
      const point = res.data?.poolAlertLocation?.coordinates;
      if (active && point && !locationEdited.current) {
        setCoords({ lat: point[1], lng: point[0] });
        setPinConfirmed(true);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [saved]);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [finding, setFinding] = useState(false);
  const [pinConfirmed, setPinConfirmed] = useState(Boolean(invitedLocation || saved));
  const [lookup, setLookup] = useState('');
  const [start, setStart] = useState(() => localInput(new Date(Date.now()+86400000)));
  const [end, setEnd] = useState(() => localInput(new Date(Date.now()+100800000)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    servicesApi.listActive().then(res => {
      if (!active) return;
      setCatalog(res.data);
      setScopes(res.meta.poolScopes);
      const initial = res.data.find(s => s._id === params.get('serviceId'));
      if (initial) { setDomain(initial.domain); setSpecific(initial.services[0]); }
    }).catch(err => active && setError(err.message));
    return () => { active = false; };
  }, [params]);

  const category = catalog.find(c => c.domain === domain && c.services.includes(specific));
  const nearby = useNearbyPools(mode !== 'pool' || (!invited && !category) ? null :
    { ...coords, ...(invited ? { poolId: invited } : { serviceCategoryId: category._id, specificService: specific }) });
  const target = nearby.items?.find(p => p.id === targetId);
  const needsBuilding = mode === 'pool' && (targetId ? target?.scope : scope) === 'building';
  const individual = mode === 'individual';
  async function findAddress() {
    setFinding(true); setLookup('');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: address, format: 'jsonv2', limit: 1 })}`);
      if (!res.ok) throw new Error();
      const [place] = await res.json();
      if (!place) throw new Error();
      locationEdited.current = true;
      setCoords({ lat: +place.lat, lng: +place.lon });
      setPinConfirmed(true);
      setLookup(place.display_name + ' · © OpenStreetMap contributors');
    } catch { setLookup('Address lookup failed. Choose the service location on the map.'); }
    finally { setFinding(false); }
  }
  async function submit(e) {
    e.preventDefault(); setError('');
    if (busy || !category || (targetId && !target)) return;
    if (!pinConfirmed) {
      setError('Find the address on the map or select the service entrance before booking.'); return;
    }
    if (individual && !(new Date(start) > new Date() && new Date(end) > new Date(start))) {
      setError('Choose a future start and a later end time.'); return;
    }
    setBusy(true);
    try {
      const res = await bookingsApi.create({
        serviceCategoryId: target?.serviceCategoryId || category._id, specificService: target?.specificService || specific,
        bookingMode: mode, location: coords, addressText: address.trim() || `Map pin ${coords.lat}, ${coords.lng}`,
        notes, ...(individual ? { timeWindow: { start: new Date(start), end: new Date(end) } } :
          { ...(targetId ? { targetPoolId: targetId, quotedPrice: target.price } : { poolScope: scope }), ...(needsBuilding && { building }) }),
      });
      navigate(`/bookings/${res.data._id}`, { state: { flashMessage: 'Booking confirmed.' } });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="max-w-3xl mx-auto space-y-5">
    <h1 className="text-2xl font-bold">{invited ? 'Join a nearby pool' : 'Manual booking'}</h1>
    {!invited && <section className={panel}>
      <label className="block">Service domain<select className={input} required value={domain} onChange={e => {setDomain(e.target.value); setSpecific(''); setChoice('');}}>
        <option value="">Choose domain</option>{[...new Set(catalog.map(c=>c.domain))].map(d=><option key={d}>{d}</option>)}</select></label>
      {domain && <label className="block">Specific service<select className={input} required value={specific} onChange={e=>{setSpecific(e.target.value); setChoice('');}}>
        <option value="">Choose service</option>{catalog.filter(c=>c.domain===domain).flatMap(c=>c.services.map(s=><option key={c._id+s}>{s}</option>))}</select></label>}
      {category && <label className="block">Booking type<select className={input} value={mode} onChange={e=>{setMode(e.target.value); setChoice('');}}>
        <option value="pool">Create pool</option><option value="individual">Individual booking</option></select></label>}
    </section>}
    {(category || invited) && <>
      <section className={panel}>
        <h2 className="font-bold text-lg">Service location</h2>
        <label className="block">Street address or landmark<input className={input} value={address} maxLength={300} onChange={e=>{locationEdited.current = true; setAddress(e.target.value); setPinConfirmed(false); setLookup('');}} /></label>
        <button type="button" className="glass-button-secondary px-4 py-2" disabled={!address.trim() || finding} onClick={findAddress}>{finding?'Searching…':'Find address on map'}</button>
        {lookup && <p role="status">{lookup}</p>}
        <p className="text-sm">Confirm the pin at your service entrance. You can also enter coordinates below.</p>
        <LocationPickerMap value={coords} onChange={point=>{locationEdited.current = true; setCoords(point); setPinConfirmed(true); setLookup('');}}/>
      </section>
      <section className={panel}>
        {individual ? <>
          <label className="block">Preferred start<input className={input} type="datetime-local" required value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label className="block">Preferred end<input className={input} type="datetime-local" required value={end} onChange={e=>setEnd(e.target.value)}/></label>
        </> : <>
          {!invited && Boolean(nearby.items?.length || choice) && <label className="block">Available pools<select className={input} value={choice} onChange={e=>setChoice(e.target.value)}>
            <option value="">Create my own pool</option>{nearby.items?.map(p=><option key={p.id} value={p.id}>{p.area} · {p.distanceMeters} m away · ₹{p.price} each</option>)}</select></label>}
          {targetId ? <div aria-live="polite">{target ? <><strong>{target.name}</strong><p>{target.area} · {target.members}/{target.capacity} booked · ₹{target.price} after joining</p><p>Service starts from {new Date(target.start).toLocaleString()}.</p></> : nearby.loading ? 'Checking pool…' : 'Pool unavailable at this location.'}</div> :
            <label className="block">Who can join?<select className={input} value={scope} onChange={e=>setScope(e.target.value)}>{Object.entries(scopes).map(([k,s])=><option key={k} value={k}>{s.label} · up to {s.capacity} people</option>)}</select></label>}
          {needsBuilding && <label className="block">Building or apartment block name<input className={input} required maxLength={160} value={building} onChange={e=>setBuilding(e.target.value)} placeholder="Building name and block, without flat number"/></label>}
          <p className="text-sm">Pool visits follow booking order. The pool closes when full or after 30 minutes.</p>
          {nearby.error && <p role="alert">{nearby.error}</p>}
        </>}
        <label className="block">Visit instructions (optional)<input className={input} maxLength={500} value={notes} onChange={e=>setNotes(e.target.value)}/></label>
      </section>
      <div className={panel}>
        <p className="font-semibold">₹{target?.price ?? category?.baseIndividualPrice} per person</p>
        {!individual && !targetId && <p className="text-sm">The price decreases for everyone as neighbors join.</p>}
        <button disabled={busy || finding || !category || Boolean(targetId && !target)} className="glass-button-primary px-5 py-3">
          {busy?'Booking…':individual?'Book individual visit':targetId?'Join pool':'Create pool'}</button>
      </div>
    </>}
    {error && <p role="alert" className="text-rose-700">{error}</p>}
  </form>;
}
