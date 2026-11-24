import React, { useState } from 'react';
import VisitMap from './VisitMap.jsx';

const labels = { accepted: 'Scheduled', assigned: 'Scheduled', confirmed: 'Scheduled', pending: 'Scheduled',
  arrived: 'Technician arrived', in_progress: 'Service in progress', completed: 'Completed', cancelled: 'Cancelled' };
export default function CustomerVisitRoute({ route }) {
  const [open, setOpen] = useState(true);
  const own = route.stops.find(stop => stop.yours);
  return <section className="visit-route" aria-label="Visit route">
    <header><div><h3>Visit route</h3><p>{route.ordering} · Your home is stop {own.number}{route.stops.at(-1).number === route.stops.length ? ' of ' + route.stops.length : ''}</p></div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide map' : 'Show map'}</button></header>
    {open && <><VisitMap route={route}/>
      <small>{route.line.length > 1 ? 'Road overview between approximate areas' : 'Schematic route'} · Only your home pin is exact.</small></>}
    <ol aria-label="Visit sequence">{route.stops.map(stop => <li key={stop.number} className={stop.yours ? 'visit-self' : undefined}>
      <b>{stop.number}</b><span>{stop.yours ? 'Your home' : 'Neighbourhood stop'}</span>
      <span>{labels[stop.status] || 'Scheduled'}</span></li>)}</ol>
  </section>;
}
