import React from 'react';

export default function ClosingPriceLimit({ value, onChange }) {
  return <label className="block text-sm">Cancel if the closing price exceeds (₹)
    <input type="number" min="0.01" step="0.01" className="glass-input w-full" placeholder="No limit · keep my visit"
      value={value} onChange={event => onChange(event.target.value)}/>
  </label>;
}
