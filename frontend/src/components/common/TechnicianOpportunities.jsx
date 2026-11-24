import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { servicesApi, techniciansApi } from '../../api/client.js';
import LocationPickerMap from './LocationPickerMap.jsx';

function WorkEstimate({ estimate }) {
  if (!estimate) return null;
  return <p className="text-sm text-slate-600">{estimate.serviceMinutes} min service · {estimate.travelMinutes == null ?
    'Travel estimate unavailable' : `${estimate.travelMinutes} min travel · ₹${estimate.hourlyRate}/hour estimated gross`}</p>;
}

export default function TechnicianOpportunities({ profile, onRefresh, opportunities }) {
  const [params, setParams] = useSearchParams();
  const linkedId = params.get('work');
  const forming = opportunities?.meta?.formingPools || [];
  const jobs = opportunities?.data || [];
  const loaded = Boolean(opportunities);
  const [catalog, setCatalog] = useState([]);
  const [location, setLocation] = useState(null);
  const [selected, setSelected] = useState([]);
  const [radius, setRadius] = useState(10);
  useEffect(() => { setRadius(profile?.serviceRadiusKm ?? 10); }, [profile?.serviceRadiusKm]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = JSON.stringify(profile?.baseLocation || null);
  const skills = JSON.stringify(profile?.serviceCategories?.map(c => c._id) || []);
  useEffect(() => { setLocation(JSON.parse(base)); }, [base]);
  useEffect(() => { setSelected(JSON.parse(skills)); }, [skills]);
  useEffect(() => {
    let active = true;
    servicesApi.listActive().then(res => active && setCatalog(res.data)).catch(err => active && setError(err.message));
    return () => { active = false; };
  }, []);
  const linkedVisible = [...forming, ...jobs].some(job => job.id === linkedId);
  useEffect(() => {
    if (linkedId && loaded) document.getElementById('work-' + linkedId)?.scrollIntoView({ block: 'center' });
  }, [linkedId, linkedVisible, loaded]);
  async function act(action) {
    setBusy(true); setError('');
    try { await action(); await onRefresh(true); }
    catch(err) { setError(err.message); } finally { setBusy(false); }
  }
  return <section className="glass-panel rounded-3xl p-6 space-y-4">
    <h2 className="text-lg font-bold">Available work</h2>
    <details><summary className="cursor-pointer font-medium">Set work location and services</summary>
      <div className="space-y-3 pt-3">
        <LocationPickerMap value={location} onChange={setLocation} height="220px"/>
        <label className="block">Service radius (km) <input type="number" min="1" max="50" value={radius} onChange={e => setRadius(e.target.value)} className="glass-input w-20"/></label>
        <fieldset><legend>Services you offer</legend>{catalog.map(c=><label className="inline-flex gap-2 mr-4" key={c._id}>
          <input type="checkbox" checked={selected.includes(c._id)} onChange={e=>setSelected(e.target.checked?[...selected,c._id]:selected.filter(id=>id!==c._id))}/>{c.name}</label>)}</fieldset>
        <button disabled={busy || !location || !(Number(radius) >= 1 && Number(radius) <= 50)} onClick={()=>act(()=>techniciansApi.updateProfile({ baseLocation: location, serviceRadiusKm: Number(radius), serviceCategories: selected }))} className="glass-button-secondary px-4 py-2">Save work preferences</button>
      </div>
    </details>
    {error && <p role="alert">{error}</p>}
    {(forming.length > 0 || jobs.length > 0) && <small>Travel estimates use visit order, straight-line distance × 1.35 and 25 km/h from your base. Gross rates exclude expenses and waiting time.</small>}
    {loaded && linkedId && !linkedVisible && <p id={'work-' + linkedId} role="status">This request is no longer forming or available for you to claim. Check Assigned Jobs for work you already claimed.</p>}
    {forming.length > 0 && <section className="space-y-2">
      <h3 className="font-semibold">Forming pools</h3>
      {forming.map(pool => {
        const expanded = linkedId === pool.id;
        const panelId = 'pool-details-' + pool.id;
        function togglePool() {
          const next = new URLSearchParams(params);
          if (expanded) next.delete('work');
          else next.set('work', pool.id);
          setParams(next, { replace: true });
        }
        return <article id={'work-' + pool.id} key={pool.id} className={`border rounded-xl ${expanded ? 'border-emerald-600' : ''}`}>
          <button type="button" aria-expanded={expanded} aria-controls={panelId} onClick={togglePool}
            className="w-full p-3 text-left flex justify-between items-center gap-3 rounded-xl hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-600">
            <span><strong className="block">{pool.name}</strong>
              <span className="text-sm">{pool.members} of {pool.capacity} members · ₹{pool.total} current total</span>
            </span>
            <span className="text-sm font-semibold text-emerald-700">{expanded ? 'Hide details' : 'View details'}</span>
          </button>
          <div id={panelId} hidden={!expanded} className="border-t p-3 text-sm space-y-1">
            <p>Service window: {new Date(pool.visitWindow.start).toLocaleString()} – {new Date(pool.visitWindow.end).toLocaleString()}</p>
            <WorkEstimate estimate={pool.estimate}/>
            <p>Current price per visit: ₹{pool.pricePerVisit}</p>
            <p>Customers can join until the pool fills or {new Date(pool.closesAt).toLocaleString()}.</p>
            {pool.reservedByMe ? <p className="font-semibold text-emerald-700">Reserved for you. It will appear in Assigned Jobs when the joining window closes.</p> :
              pool.canReserve ? <button type="button" className="glass-button-primary px-3 py-2" disabled={busy}
                onClick={()=>act(()=>techniciansApi.claim(pool.id,'pool'))}>Reserve this pool</button> :
                pool.unavailableReason && <p className="text-amber-700">{pool.unavailableReason}</p>}
          </div>
        </article>;
      })}
    </section>}
    {jobs.length ? <p className="text-sm">Oldest requests first. Claim a job to add it to your assigned work.</p> :
      <p className="text-sm">{forming.length ? 'No locked jobs are ready yet. You can reserve a forming pool above.' : 'No eligible jobs are ready to claim.'}</p>}
    {jobs.map(j=><article id={'work-' + j.id} key={j.id} className="border rounded-xl p-3 flex items-center justify-between">
      <div><strong>{j.name}</strong><p>{j.kind} · {j.distanceKm} km away · {j.members} visits · ₹{j.total} total</p>
      <WorkEstimate estimate={j.estimate}/><p className="text-sm">{new Date(j.start).toLocaleString()}</p></div>
      <button className="glass-button-primary px-3 py-2" disabled={busy} onClick={()=>act(()=>techniciansApi.claim(j.id,j.kind))}>Claim job</button>
    </article>)}
  </section>;
}
