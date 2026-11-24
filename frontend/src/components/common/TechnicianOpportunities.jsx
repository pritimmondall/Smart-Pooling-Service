import React, { useEffect, useState } from 'react';
import { SlidersHorizontal, ArrowUpRight } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { techniciansApi } from '../../api/client.js';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const linkedVisible = [...forming, ...jobs].some(job => job.id === linkedId);
  useEffect(() => {
    if (linkedId && loaded) document.getElementById('work-' + linkedId)?.scrollIntoView({ block: 'center' });
  }, [linkedId, linkedVisible, loaded]);
  async function act(action) {
    setBusy(true); setError('');
    try { await action(); await onRefresh(true); }
    catch(err) { setError(err.message); } finally { setBusy(false); }
  }
  return <section className="desk-opportunities" id="available-work">
    <h2>Available work</h2>
    <Link to="/technician/profile-setup" className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800">
      <SlidersHorizontal size={15}/>{profile?.serviceCategories?.length ? 'Edit work preferences' : 'Complete your work profile'}
    </Link>
    {error && <p role="alert">{error}</p>}

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
    {jobs.length ? <p className="text-sm">Ready to claim · oldest first</p> :
      <p className="text-sm">{forming.length ? 'No locked jobs are ready yet. You can reserve a forming pool above.' : 'No eligible jobs are ready to claim.'}</p>}
    {jobs.map(j=><article id={'work-' + j.id} key={j.id} className="desk-offer">
      <div><span className="desk-kind">{j.kind === 'pool' ? 'Service pool' : 'Individual booking'}</span><h3>{j.name}</h3><p>{j.distanceKm} km away · {j.members} {j.members === 1 ? 'visit' : 'visits'}</p>
      <WorkEstimate estimate={j.estimate}/><p className="text-sm">{new Date(j.start).toLocaleString()}</p></div>
      <div className="desk-offer-claim"><strong>₹{j.total}</strong><button className="glass-button-primary" disabled={busy} onClick={()=>act(()=>techniciansApi.claim(j.id,j.kind))}>Claim job<ArrowUpRight size={14}/></button></div>
    </article>)}

    {(forming.length > 0 || jobs.length > 0) && <details className="desk-assumptions"><summary>How estimates work</summary><p>Travel estimates use visit order, straight-line distance × 1.35 and 25 km/h from your base. Gross rates exclude expenses and waiting time.</p></details>}
  </section>;
}
