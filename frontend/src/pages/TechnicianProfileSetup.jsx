import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { servicesApi, techniciansApi } from '../api/client.js';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const inputClass = 'glass-input mt-1 block w-full';

export default function TechnicianProfileSetup() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setError('');
    Promise.all([techniciansApi.getMe(), servicesApi.listActive()])
      .then(([{ data: profile }, { data: categories }]) => {
        if (!active) return;
        const selected = profile.serviceCategories.map(category => category._id);
        setCatalog(categories);
        setDraft({
          serviceCategories: categories.filter(category => selected.includes(category._id)).map(category => category._id),
          addressText: profile.addressText || '',
          baseLocation: profile.baseLocation,
          serviceRadiusKm: profile.serviceRadiusKm,
          maxPoolCapacity: profile.maxPoolCapacity,
          workingHours: profile.workingHours,
        });
      }).catch(err => { if (active) setError(err.message || 'Could not load your work profile.'); });
    return () => { active = false; };
  }, [attempt]);

  if (!draft) return error ? <div role="alert">{error} <button className="underline" onClick={() => setAttempt(n => n + 1)}>Retry</button></div>
    : <LoadingSpinner label="Loading your work profile…"/>;

  const change = (field, value) => setDraft(prev => ({ ...prev, [field]: value }));
  const changeHours = (field, value) => setDraft(prev => ({ ...prev, workingHours: { ...prev.workingHours, [field]: value } }));
  const toggle = (items, value) => items.includes(value) ? items.filter(item => item !== value) : [...items, value];

  async function save(event) {
    event.preventDefault();
    if (!draft.serviceCategories.length) return setError('Select at least one service field.');
    if (!draft.workingHours.daysOfWeek.length) return setError('Select at least one working day.');
    if (draft.workingHours.start >= draft.workingHours.end) return setError('End time must be after start time.');
    setError('');
    setSaving(true);
    try {
      await techniciansApi.updateProfile({ ...draft, serviceRadiusKm: Number(draft.serviceRadiusKm), maxPoolCapacity: Number(draft.maxPoolCapacity) });
      navigate('/technician/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Could not save your work profile.');
    } finally { setSaving(false); }
  }

  return <div className="max-w-2xl mx-auto space-y-5">
    <header><h1 className="text-3xl font-bold tracking-tight text-emerald-950">Your technician work profile</h1>
      <p className="mt-2 text-sm text-slate-600">Choose the services you offer and how far you can travel for a job.</p></header>
    <form onSubmit={save} className="glass-panel rounded-2xl p-5 sm:p-7 space-y-6 text-sm">
      <fieldset><legend className="font-bold text-lg mb-2">Service fields</legend>
        <div className="grid sm:grid-cols-2 gap-2">{catalog.map(category => <label key={category._id}
          className="flex items-center gap-3 border rounded-xl p-3 cursor-pointer has-[:checked]:border-emerald-600 has-[:checked]:bg-emerald-50">
          <input type="checkbox" name="serviceCategories" value={category._id} checked={draft.serviceCategories.includes(category._id)}
            onChange={() => change('serviceCategories', toggle(draft.serviceCategories, category._id))}/>{category.name}
        </label>)}</div>
        {!catalog.length && <p role="status">No active service fields are available yet. <button type="button" className="underline" onClick={() => setAttempt(n => n + 1)}>Reload fields</button></p>}
      </fieldset>
      <fieldset className="space-y-3"><legend className="font-bold text-lg">Work area</legend>
        <LocationPickerMap value={draft.baseLocation} onChange={value => change('baseLocation', value)} height="180px"/>
        <label className="block">Base address or landmark (optional)<input className={inputClass} maxLength={250}
          value={draft.addressText} onChange={e => change('addressText', e.target.value)}/></label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label>Service radius (km)<input name="serviceRadiusKm" className={inputClass} type="number" min="1" max="50" step="any" required value={draft.serviceRadiusKm} onChange={e => change('serviceRadiusKm', e.target.value)}/></label>
          <label>Maximum concurrent jobs<input className={inputClass} type="number" min="1" max="10" required value={draft.maxPoolCapacity} onChange={e => change('maxPoolCapacity', e.target.value)}/></label>
        </div>
      </fieldset>
      <fieldset><legend className="font-bold text-lg mb-2">Working days and hours</legend>
        <div className="flex flex-wrap gap-3">{weekdays.map((day, i) => <label key={day} className="inline-flex items-center gap-1">
          <input type="checkbox" name="workingDay" value={i} checked={draft.workingHours.daysOfWeek.includes(i)} onChange={() => changeHours('daysOfWeek', toggle(draft.workingHours.daysOfWeek, i))}/>{day}
        </label>)}</div>
        <div className="grid grid-cols-2 gap-3 mt-3">{['start', 'end'].map(field => <label key={field}>{field === 'start' ? 'Start time' : 'End time'}
          <input className={inputClass} type="time" required value={draft.workingHours[field]} onChange={e => changeHours(field, e.target.value)}/>
        </label>)}</div>
      </fieldset>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      <button className="glass-button-primary" type="submit" disabled={saving || !catalog.length}>{saving ? 'Saving…' : 'Save work profile'}</button>
    </form>
  </div>;
}
