import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

const latLng = ([lng, lat]) => [lat, lng];

export default function VisitMap({ route, precise = false }) {
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
        title: 'Visit ' + label + (precise ? '' : yours ? ' · Your home' : ' · Approximate area'),
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
  }, [route, precise]);
  return <div className="customer-visit-map" aria-label="Map of numbered visits" ref={container}/>;
}

