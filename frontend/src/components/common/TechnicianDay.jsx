import React, { useState } from 'react';
import { Calendar, MapPin, Navigation, Phone, Route, ArrowUpRight, Clock } from 'lucide-react';
import { techniciansApi } from '../../api/client.js';
import VisitMap from './VisitMap.jsx';
import Modal from './Modal.jsx';

const onSite = status => ['arrived', 'in_progress'].includes(status);
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function TechnicianDay({ routes, processing, onArrive, onStart, onComplete, openIncident, pending, workNotice }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const ordered = routes.filter(route => route.stops.length).slice()
    .sort((a, b) => new Date(a.timeWindow.start) - new Date(b.timeWindow.start));
  const candidates = ordered.filter(route => route.status !== 'assigned');
  const next = candidates.find(route => onSite(route.stops[0].status)) || candidates[0];
  const stop = next?.stops[0];
  const points = next?.stops.filter(s => s.location?.coordinates).map(s => ({
    point: s.location.coordinates, number: s.sequenceIndex, status: s.status,
  })) || [];
  const schedule = ordered.filter(route => new Date(route.timeWindow.start) < tomorrow && new Date(route.timeWindow.end) >= today);
  const action = stop?.status === 'in_progress' ? [onComplete, 'Complete Service'] :
    stop?.status === 'arrived' ? [onStart, 'Start Service'] : [onArrive, 'Mark Arrived'];
  return <div className="desk-day">
    <section className="desk-visit">
      <div className="desk-visit-info">
        <div className="desk-visit-label"><Navigation size={16}/><h2>Next visit</h2></div>
        {stop ? <>
          <p className="desk-stop-meta">Stop {stop.sequenceIndex} · {next.serviceCategory?.name} · {stop.status.replace('_',' ')}</p>
          <h3>{stop.customer.name}</h3>
          <p className="desk-address"><MapPin size={16}/>{stop.addressText}</p>
          <p className="desk-address"><Clock size={16}/>{new Date(stop.timeWindow.start).toLocaleDateString()} · {time(stop.timeWindow.start)} – {time(stop.timeWindow.end)}</p>
          <div className="desk-visit-actions">
            <button className="desk-primary" disabled={processing[stop.bookingId]} onClick={() => action[0](next.jobId, stop.bookingId)}>{action[1]}<ArrowUpRight size={16}/></button>
            {stop.location?.coordinates && <a target="_blank" rel="noreferrer" href={'https://www.google.com/maps/dir/?api=1&destination=' + stop.location.coordinates.slice().reverse().join(',')}><Navigation size={15}/>Directions</a>}
            {stop.customer.phone && stop.customer.phone !== 'N/A' && <a href={'tel:' + stop.customer.phone} aria-label={'Call ' + stop.customer.name + ' at ' + stop.customer.phone}><Phone size={15}/>Call</a>}
          </div>
          <details><summary className="cursor-pointer text-sm font-semibold">Remaining visits and exceptions</summary>
            <ol className="mt-2 space-y-2">{next.stops.map(visit => <li key={visit.bookingId} className="flex justify-between gap-2 text-sm">
              <span>{visit.sequenceIndex}. {visit.customer.name} · {visit.addressText}</span>
              <button className="text-rose-700 shrink-0" onClick={() => openIncident(next, visit)}>Report issue</button>
            </li>)}</ol>
          </details>
        </> : <>
          <Route className="desk-route-art" aria-hidden="true" strokeWidth={1}/>
          <h3>{pending ? 'Your assignment is ready' : 'No visit lined up'}</h3>
          <p className="desk-visit-note">{pending ? 'Accept a job to see your first stop and directions.' : workNotice ? 'Your next stop will appear here after you accept an assignment.' : 'Claim available work to start planning your route.'}</p>
          {(pending > 0 || !workNotice) && <a className="desk-primary" href={pending ? '#assigned-work' : '#available-work'}>{pending ? 'Review assignments' : 'Browse available work'}<ArrowUpRight size={16}/></a>}
        </>}
      </div>
      {points.length > 0 && <div className="desk-map"><VisitMap precise route={{ line: [], stops: points }}/>
        <small>Dashed lines show the remaining visit order.</small></div>}
    </section>
    <section className="desk-schedule"><header><h2>Today’s schedule</h2><Calendar size={20}/></header>
      {!schedule.length && <div className="desk-schedule-empty"><Clock size={24}/><p>No remaining visits today.</p></div>}
      {schedule.map(route => {
        const conflict = schedule.some(other => other.jobId !== route.jobId &&
          new Date(other.timeWindow.start) < new Date(route.timeWindow.end) && new Date(route.timeWindow.start) < new Date(other.timeWindow.end));
        return <div key={route.jobId} className="rounded-xl bg-slate-50 p-3 text-sm">
          <strong>{time(route.timeWindow.start)} – {time(route.timeWindow.end)} · {route.serviceCategory?.name}</strong>
          <span> · {route.status.replace('_',' ')}</span>{conflict && <strong className="text-amber-700"> · Overlapping job windows</strong>}
          {route.stops.map(visit => <div key={visit.bookingId} className="flex justify-between gap-3 mt-1">
            <span>{visit.sequenceIndex}. {visit.customer.name} · {visit.addressText}
              {Date.now() > Date.parse(visit.timeWindow.end) && <strong className="text-rose-700"> · Window elapsed</strong>}
              {visit.estimatedArrival && Date.parse(visit.estimatedArrival) > Date.parse(visit.timeWindow.end) && <span> · Estimated late arrival</span>}</span>
            {route.status !== 'assigned' && <button className="text-rose-700 shrink-0" onClick={() => openIncident(route, visit)}>Report issue</button>}
          </div>)}
        </div>;
      })}
    </section>
  </div>;
}

export function VisitException({ incident, onClose, onRefresh, onFeedback }) {
  const [reason, setReason] = useState('Customer unavailable');
  const [details, setDetails] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function cancelVisit() {
    if (saving || !incident) return;
    setSaving(true);
    try {
      await techniciansApi.cancelJobStop(incident.route.jobId, incident.visit.bookingId,
        [reason === 'Other' ? '' : reason, details.trim()].filter(Boolean).join(' — '));
      onClose();
      await onRefresh(true);
      onFeedback('Visit cancelled. The customer has been notified.');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return (
    <Modal isOpen={Boolean(incident)} onClose={() => !saving && onClose()} title="Cancel visit">
      {incident && <div className="space-y-3"><p>Cancel the visit to {incident.visit.customer.name}? The customer will receive the reason.
        {incident.route.stops.length > 1 && ' Other visits in this pool will continue.'}</p>
        <label className="block">Reason<select className="glass-input block w-full" value={reason} onChange={e => setReason(e.target.value)}>
          {['Customer unavailable', 'Cannot access building', 'Other'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="block">Details {reason === 'Other' ? '(required)' : '(optional)'}<textarea className="glass-input block w-full" maxLength={420} value={details} onChange={e => setDetails(e.target.value)}/></label>
        {error && <p role="alert">{error}</p>}
        <button className="glass-button-primary px-4 py-2" disabled={saving || (reason === 'Other' && !details.trim())} onClick={cancelVisit}>Confirm visit cancellation</button>
      </div>}
    </Modal>
  );
}
