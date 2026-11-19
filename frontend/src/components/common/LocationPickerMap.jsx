import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapPin, Navigation } from 'lucide-react';

const KOLKATA_DEFAULT = { lat: 22.5015, lng: 88.3531 };

const PRESET_ZONES = [
  { name: 'Green Park / Jadavpur', lat: 22.5015, lng: 88.3531 },
  { name: 'Ballygunge', lat: 22.5176, lng: 88.3639 },
  { name: 'Salt Lake Sector II', lat: 22.5867, lng: 88.4171 },
];

function createPinIcon() {
  return L.divIcon({
    className: 'custom-map-pin',
    html: `
      <div style="position: relative; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
        <div style="position: absolute; width: 28px; height: 28px; border-radius: 50%; background: rgba(34, 197, 94, 0.25); animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
        <div style="width: 28px; height: 28px; border-radius: 50% 50% 50% 0; background: #16a34a; transform: rotate(-45deg); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(22, 163, 74, 0.4); border: 2px solid white;">
          <div style="width: 8px; height: 8px; background: white; border-radius: 50%; transform: rotate(45deg);"></div>
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 28],
  });
}

export default function LocationPickerMap({
  value,
  onChange,
  readOnly = false,
  height = '300px',
  className = '',
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);

  // Normalize initial coordinates
  const initialLat = Number(value?.lat ?? (Array.isArray(value?.coordinates) ? value.coordinates[1] : KOLKATA_DEFAULT.lat));
  const initialLng = Number(value?.lng ?? (Array.isArray(value?.coordinates) ? value.coordinates[0] : KOLKATA_DEFAULT.lng));

  const [coords, setCoords] = useState({
    lat: Number.isFinite(initialLat) ? initialLat : KOLKATA_DEFAULT.lat,
    lng: Number.isFinite(initialLng) ? initialLng : KOLKATA_DEFAULT.lng,
  });

  // Keep internal state in sync with external value
  useEffect(() => {
    if (!value) return;
    const lat = Number(value.lat ?? (Array.isArray(value.coordinates) ? value.coordinates[1] : null));
    const lng = Number(value.lng ?? (Array.isArray(value.coordinates) ? value.coordinates[0] : null));
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setCoords({ lat, lng });
      if (markerRef.current) {
        markerRef.current.setLatLng([lat, lng]);
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.panTo([lat, lng]);
      }
    }
  }, [value]);

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    // Initialize Leaflet Map
    const map = L.map(mapContainerRef.current, {
      center: [coords.lat, coords.lng],
      zoom: 14,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    // Pin marker
    const pinIcon = createPinIcon();
    const marker = L.marker([coords.lat, coords.lng], {
      icon: pinIcon,
      draggable: !readOnly,
    }).addTo(map);

    if (!readOnly) {
      marker.on('dragend', () => {
        const position = marker.getLatLng();
        const newCoords = {
          lat: Number(position.lat.toFixed(6)),
          lng: Number(position.lng.toFixed(6)),
        };
        setCoords(newCoords);
        onChange?.(newCoords);
      });

      map.on('click', (e) => {
        const newCoords = {
          lat: Number(e.latlng.lat.toFixed(6)),
          lng: Number(e.latlng.lng.toFixed(6)),
        };
        marker.setLatLng(e.latlng);
        setCoords(newCoords);
        onChange?.(newCoords);
      });
    }

    mapInstanceRef.current = map;
    markerRef.current = marker;

    // Invalidate size to guarantee correct rendering
    setTimeout(() => {
      map.invalidateSize();
    }, 200);

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
  }, []); // Run once on mount

  const handlePresetClick = (preset) => {
    const newCoords = { lat: preset.lat, lng: preset.lng };
    setCoords(newCoords);
    if (markerRef.current) markerRef.current.setLatLng([preset.lat, preset.lng]);
    if (mapInstanceRef.current) mapInstanceRef.current.flyTo([preset.lat, preset.lng], 15);
    onChange?.(newCoords);
  };

  const handleNumericChange = (field, rawValue) => {
    const draft = { ...coords, [field]: rawValue };
    setCoords(draft);
    const newCoords = { lat: Number(draft.lat), lng: Number(draft.lng) };
    if (draft.lat !== '' && draft.lng !== '' && Number.isFinite(newCoords.lat) && Number.isFinite(newCoords.lng)
      && Math.abs(newCoords.lat) <= 90 && Math.abs(newCoords.lng) <= 180) {
      if (markerRef.current) markerRef.current.setLatLng([newCoords.lat, newCoords.lng]);
      if (mapInstanceRef.current) mapInstanceRef.current.panTo([newCoords.lat, newCoords.lng]);
      onChange?.(newCoords);
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Map Container */}
      <div className="relative rounded-2xl overflow-hidden border border-slate-200/80 shadow-inner bg-slate-100">
        <div ref={mapContainerRef} style={{ height }} className="w-full z-10" />

        {/* Floating helper tag */}
        {!readOnly && (
          <div className="absolute top-3 right-3 z-20 bg-white/90 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-medium text-slate-600 shadow-sm border border-slate-200 flex items-center gap-1.5 pointer-events-none">
            <Navigation className="w-3 h-3 text-emerald-600" />
            Click or drag pin to choose location
          </div>
        )}
      </div>

      {/* Preset Zone Quick Select */}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500 mr-1 flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5 text-slate-400" /> Quick zones:
          </span>
          {PRESET_ZONES.map((preset) => (
            <button
              key={preset.name}
              type="button"
              onClick={() => handlePresetClick(preset)}
              className="px-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-white/80 hover:bg-emerald-50 hover:border-emerald-200 hover:text-emerald-800 transition-colors"
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}

      {/* Coordinate Display / Inputs */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
            Latitude
          </label>
          <input
            type="number"
            step="any"
            min={-90}
            max={90}
            required={!readOnly}
            value={coords.lat ?? ''}
            readOnly={readOnly}
            onChange={(e) => handleNumericChange('lat', e.target.value)}
            className="w-full text-xs font-mono bg-white/80 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1">
            Longitude
          </label>
          <input
            type="number"
            step="any"
            min={-180}
            max={180}
            required={!readOnly}
            value={coords.lng ?? ''}
            readOnly={readOnly}
            onChange={(e) => handleNumericChange('lng', e.target.value)}
            className="w-full text-xs font-mono bg-white/80 border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      </div>
    </div>
  );
}
