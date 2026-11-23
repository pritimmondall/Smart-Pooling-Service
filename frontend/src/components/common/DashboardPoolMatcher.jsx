import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { bookingsApi, servicesApi } from '../../api/client.js';

import { ArrowRight, SlidersHorizontal } from 'lucide-react';

import ClosingPriceLimit from './ClosingPriceLimit.jsx';
import PoolPriceWatches from './PoolPriceWatches.jsx';

function localTime(hoursAhead) {
  const date = new Date(Date.now() + hoursAhead * 3600000);
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function DashboardPoolMatcher({ location, children }) {
  const navigate = useNavigate();
  const [services, setServices] = useState([]);
  const [choice, setChoice] = useState('');
  const [start, setStart] = useState(() => localTime(24));
  const [end, setEnd] = useState(() => localTime(28));
  const [flexible, setFlexible] = useState(false);
  const [limit, setLimit] = useState('');
  const [selectedShift, setSelectedShift] = useState(0);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    servicesApi.listActive().then(({ data }) => {
      if (active) setServices(data.flatMap(category => category.services.map(name =>
        ({ id: category._id, name, key: category._id + '/' + name }))));
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const selected = services.find(item => item.key === choice);
  const key = JSON.stringify([choice, start, end, location, flexible]);
  const options = preview?.key === key ? preview.options : [];
  const option = options.find(item => item.shift === selectedShift);
  const quote = option?.quote;
  const request = selected && location && new Date(start) > new Date() && new Date(end) > new Date(start)
    ? { serviceCategoryId: selected.id, specificService: selected.name, location,
      timeWindow: { start: new Date(start), end: new Date(end) } } : null;

  async function submit(event) {
    event.preventDefault();
    if (busy || !selected) return;
    setError('');
    if (!location) { setError('Choose your service location first.'); return; }
    if (!(new Date(start) > new Date() && new Date(end) > new Date(start))) {
      setError('Choose a future start and a later end time.'); return;
    }

    setBusy(true);
    try {
      if (quote) {
        const res = await bookingsApi.create({ ...request, timeWindow: option.timeWindow,
          ...(limit && { closingPriceLimit: Number(limit) }), bookingMode: 'pool', quotedPrice: quote.finalPricePerMember,
          addressText: `Service pin ${location.lat}, ${location.lng}` });
        navigate('/bookings/' + res.data._id);
      } else {
        const shifts = flexible ? [0, -1, 1, -2, 2] : [0];
        const quotes = await Promise.all(shifts.filter(shift => +request.timeWindow.start + shift * 3600000 > Date.now()).map(async shift => {
          const timeWindow = { start: new Date(+request.timeWindow.start + shift * 3600000), end: new Date(+request.timeWindow.end + shift * 3600000) };
          const res = await bookingsApi.quote({ ...request, timeWindow });
          return { shift, timeWindow, quote: res.data };
        }));
        setSelectedShift(0);
        setPreview({ key, options: quotes.filter((item, i) => i === 0 || item.quote.finalPricePerMember < quotes[0].quote.finalPricePerMember) });
      }
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally { setBusy(false); }
  }
  return <section className="pool-panel pool-finder">
    <div className="pool-section-heading"><span className="pool-icon"><SlidersHorizontal/></span><h2>Pool finder</h2></div>
    {children}
    <form onSubmit={submit} className="space-y-4">
      <label className="block">Service<select className="glass-input w-full" required value={choice} onChange={e => setChoice(e.target.value)}>
        <option value="">Choose a service</option>{services.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
      </select></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Preferred start<input type="datetime-local" className="glass-input w-full" value={start} required onChange={e => setStart(e.target.value)} /></label>
        <label>Preferred end<input type="datetime-local" className="glass-input w-full" value={end} required onChange={e => setEnd(e.target.value)} /></label>
      </div>
      <label className="flex gap-2 items-center"><input type="checkbox" checked={flexible} onChange={e => setFlexible(e.target.checked)}/>I can shift my visit by up to 2 hours</label>
      {flexible && quote && (options.length > 1 ? <fieldset className="space-y-2"><legend>Choose a time and price</legend>
        {options.map(item => <label key={item.shift} className="block"><input type="radio" name="visit-window" checked={item.shift === selectedShift} onChange={() => setSelectedShift(item.shift)}/> {item.shift === 0 ? 'Keep my time' : `${Math.abs(item.shift)}h ${item.shift < 0 ? 'earlier' : 'later'}`} · {item.timeWindow.start.toLocaleString()} – {item.timeWindow.end.toLocaleTimeString()} · ₹{item.quote.finalPricePerMember}</label>)}
      </fieldset> : <p className="text-sm">No cheaper match within two hours of your preferred time.</p>)}
      {quote && <div role="status" className="pool-quote">
        <h2 className="font-semibold">{quote.recommendedMatch ? selected.name + ' · compatible pool found' : 'Start the first pool for this visit'}</h2>
        {quote.recommendedMatch && <p>Pool centre {quote.recommendedMatch.distanceMeters} m away · {quote.recommendedMatch.overlapMinutes} minutes of shared availability</p>}
        <p>Individual ₹{quote.individualBasePrice} · <strong>₹{quote.finalPricePerMember} each after booking</strong></p>
        <p>{quote.memberCount} {quote.memberCount === 1 ? 'member' : 'members'} including you · Save ₹{quote.totalSavingsPerMember} ({quote.discountPercentage}%)</p>
        {!quote.recommendedMatch && <p>Your price drops when another eligible customer joins.</p>}
      </div>}
      {quote && <ClosingPriceLimit value={limit} onChange={setLimit}/>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-4 items-center">
        <button disabled={busy} className="pool-primary">{busy ? 'Please wait…' : !quote ? 'Find my best pool' : quote.recommendedMatch ? 'Confirm pooled booking' : 'Start a pool'} <ArrowRight size={16}/></button>
        <Link className="pool-secondary" to={'/create-booking?' + new URLSearchParams({
          mode: 'individual', ...(selected && { serviceId: selected.id, service: selected.name }),
          ...(location && { lat: location.lat, lng: location.lng }), start, end,
        })}>Book individually</Link>
      </div>
    </form>
    <PoolPriceWatches request={request && { ...request, timeWindow: option?.timeWindow || request.timeWindow }}/>
  </section>;
}
