import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, servicesApi } from '../../api/client.js';

import { ArrowRight } from 'lucide-react';

import TimeShiftOffer from './TimeShiftOffer.jsx';

function localTime(hoursAhead, initial) {
  const date = initial && Number.isFinite(Date.parse(initial)) ? new Date(initial) : new Date(Date.now() + hoursAhead * 3600000);
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function DashboardPoolMatcher({ location, params, address, children }) {
  const navigate = useNavigate();
  const [services, setServices] = useState([]);
  const [choice, setChoice] = useState('');
  const [start, setStart] = useState(() => localTime(24, params.get('start')));
  const [end, setEnd] = useState(() => localTime(28, params.get('end')));
  const [acceptShift, setAcceptShift] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    servicesApi.listActive().then(({ data }) => {
      if (!active) return;
      const options = data.flatMap(category => category.services.map(name =>
        ({ id: category._id, name, key: category._id + '/' + name })));
      setServices(options);
      const preset = options.find(item => item.id === params.get('serviceId') &&
        (!params.get('service') || item.name === params.get('service')));
      setChoice(preset?.key || '');
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [params]);
  const selected = services.find(item => item.key === choice);
  const key = JSON.stringify([choice, start, end, location]);
  const quote = preview?.key === key ? preview.quote : null;
  const offer = acceptShift && quote?.shiftOffer;
  const request = selected && location && new Date(start) > new Date() && new Date(end) > new Date(start)
    ? { automaticDispatch: true, serviceCategoryId: selected.id, specificService: selected.name, location,
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
        const res = await bookingsApi.create({ ...request, ...(offer && { acceptShift: offer }),
          bookingMode: 'pool', quotedPrice: offer ? offer.price : quote.finalPricePerMember,
          addressText: address?.trim() || `Service pin ${location.lat}, ${location.lng}` });
        navigate('/bookings/' + res.data._id);
      } else {
        const res = await bookingsApi.quote(request);
        setAcceptShift(false);
        setPreview({ key, quote: res.data });
      }
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally { setBusy(false); }
  }
  return <section className="pool-panel pool-finder">
    <form onSubmit={submit} className="space-y-4">
      <label className="block">Service<select className="glass-input w-full" required value={choice} onChange={e => setChoice(e.target.value)}>
        <option value="">Choose a service</option>{services.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
      </select></label>
      {children}
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Preferred start<input type="datetime-local" className="glass-input w-full" value={start} required onChange={e => setStart(e.target.value)} /></label>
        <label>Preferred end<input type="datetime-local" className="glass-input w-full" value={end} required onChange={e => setEnd(e.target.value)} /></label>
      </div>
      <TimeShiftOffer offer={quote?.shiftOffer} accepted={acceptShift} onChange={setAcceptShift}/>
      {quote && !offer && <div role="status" className="pool-quote">
        <p><strong>₹{quote.finalPricePerMember} per visit</strong></p>
        <p>{quote.memberCount > 1 ? `You save ₹${quote.totalSavingsPerMember} with ${quote.memberCount} bookings in this group.` : 'Your price can drop if another nearby booking matches.'}</p>
      </div>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-4 items-center">
        <button disabled={busy} className="pool-primary">{busy ? 'Please wait…' : !quote ? 'Check visit price' : 'Confirm booking'} <ArrowRight size={16}/></button>
      </div>
    </form>
  </section>;
}
