import React from 'react';

export default function TimeShiftOffer({ offer, accepted, onChange }) {
  if (!offer) return null;
  const start = new Date(offer.timeWindow.start);
  const end = new Date(offer.timeWindow.end);
  return <fieldset className="space-y-2 rounded-xl border p-4">
    <legend className="font-semibold">A nearby group can fit your visit at another time</legend>
    <label className="block"><input type="radio" name="shift" checked={!accepted} onChange={() => onChange(false)}/> Keep my preferred time</label>
    <label className="block"><input type="radio" name="shift" checked={accepted} onChange={() => onChange(true)}/> Shift to {start.toLocaleString()} – {end.toLocaleString()} for ₹{offer.price} · Save ₹{offer.savings}</label>
    <p className="text-sm">Includes ₹{(offer.creditPaise / 100).toFixed(2)} extra savings for changing your time.</p>
  </fieldset>;
}
