import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

const labels = { accepted: 'Scheduled', assigned: 'Scheduled', confirmed: 'Scheduled', pending: 'Scheduled',
  arrived: 'Technician arrived', in_progress: 'Service in progress', completed: 'Completed', cancelled: 'Cancelled' };
const latLng = ([lng, lat]) => [lat, lng];

function VisitMap({ route }) {
  const container = useRef(null);
  const map = useRef(null);
  const lastExtent = useRef('');
  useEffect(() => {
    const instance = L.map(container.current, { scrollWheelZoom: false }).setView([0, 0], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(instance);
    map.current = instance;
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(container.current);
    return () => { observer.disconnect(); instance.remove(); map.current = null; lastExtent.current = ''; };
  }, []);
  useEffect(() => {
    const instance = map.current;
    const layer = L.layerGroup().addTo(instance);
    const road = route.line.length > 1;
    const path = road ? route.line.map(latLng) : route.stops.map(stop => latLng(stop.point));
    L.polyline(path, { color: '#27775b', weight: 4, dashArray: road ? undefined : '6 8' }).addTo(layer);
    const groups = new Map();
    for (const stop of route.stops) {
      const key = stop.point.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(stop);
    }
    for (const group of groups.values()) {
      const yours = group.some(stop => stop.yours);
      const done = group.every(stop => ['completed', 'cancelled'].includes(stop.status));
      const underway = group.some(stop => ['arrived', 'in_progress'].includes(stop.status));
      const label = group.map(stop => stop.number).join('·');
      const width = Math.max(30, label.length * 9 + 12);
      L.marker(latLng(group[0].point), {
        title: 'Visit ' + label + (yours ? ' · Your home' : ' · Approximate area'),
        zIndexOffset: yours ? 500 : 0,
        icon: L.divIcon({ className: 'visit-pin' + (yours ? ' visit-own' : '') + (done ? ' visit-done' : underway ? ' visit-underway' : ''),
          html: label, iconSize: [width, 30], iconAnchor: [width / 2, 15] }),
      }).addTo(layer);
    }
    const bounds = [...path, ...route.stops.map(stop => latLng(stop.point))];
    const extent = JSON.stringify(bounds);
    if (extent !== lastExtent.current) {
      instance.fitBounds(bounds, { padding: [28, 28], maxZoom: 17, animate: false });
      lastExtent.current = extent;
    }
    return () => layer.remove();
  }, [route]);
  return <div className="customer-visit-map" aria-label="Map of numbered visits" ref={container}/>;
}

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
