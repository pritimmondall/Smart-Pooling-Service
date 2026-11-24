import React, { useState } from 'react';
import { poolsApi } from '../../api/client.js';

function localMinute(value) {
  const date = new Date(value);
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function PoolCutoffEditor({ poolId, cutoff, serviceStart, onSaved }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const date = new Date(draft);
    if (!(date > new Date() && date <= new Date(serviceStart))) {
      setError('Choose a future time at or before the service window starts.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await poolsApi.updateCutoff(poolId, date.toISOString());
      onSaved(result.data.lockCutoffTime);
      setDraft(null);
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not update the cutoff.');
    } finally {
      setSaving(false);
    }
  }
  if (draft === null) return <div>
    <button type="button" className="text-sm font-semibold text-emerald-800 underline" onClick={() => {
      setSaved(false); setError(''); setDraft(localMinute(cutoff));
    }}>Edit lock cutoff</button>
    {saved && <p role="status" className="text-sm">Joining deadline updated.</p>}
  </div>;
  return <form onSubmit={submit} className="space-y-2 rounded-xl border border-emerald-200 bg-white p-3 text-sm">
    <label className="block font-semibold">Joining deadline
      <input className="glass-input block max-w-full mt-1" type="datetime-local" required
        min={localMinute(Date.now())} max={localMinute(serviceStart)} value={draft} onChange={e => setDraft(e.target.value)}/>
    </label>
    <p>Choose a time by {new Date(serviceStart).toLocaleString()}. A full pool locks immediately.</p>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    <div className="flex gap-3"><button disabled={saving} className="glass-button-primary">{saving ? 'Saving…' : 'Save cutoff'}</button>
      <button type="button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button></div>
  </form>;
}
