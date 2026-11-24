import React, { useEffect, useState } from 'react';
import { techniciansApi } from '../api/client.js';

export default function TechnicianApprovals() {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState([]);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    techniciansApi.pendingApplications(page).then(({ data, meta }) => {
      if (!active) return;
      const last = Math.max(1, meta.pagination.pages);
      setPages(last);
      setRows(data);
      if (page > last) setPage(last);
    }).catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision]);

  async function decide(profile, status) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await techniciansApi.reviewApplication(profile._id, status);
      setMessage(profile.userId.name + ' · ' + status);
      setRevision(value => value + 1);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return <section className="max-w-3xl mx-auto space-y-4">
    <h1 className="text-3xl font-bold">Technician approvals</h1>
    <button className="glass-button-secondary" disabled={loading || saving} onClick={() => setRevision(n => n + 1)}>Refresh applications</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {loading ? <p>Loading applications…</p> : <>
      {!error && !rows.length && <p>No applications are awaiting review.</p>}
      {rows.map(profile => <article key={profile._id} className="glass-panel rounded-xl p-5 space-y-2">
        <h2 className="font-bold">{profile.userId?.name}</h2><p>{profile.userId?.email}</p>
        <p>{profile.serviceCategories.map(c => c.name).join(', ') || 'Service fields pending'}</p>
        <p>{profile.addressText || profile.zoneId?.name || 'Service area'} · {profile.serviceRadiusKm} km radius</p>
        <div className="flex gap-2">
          <button className="glass-button-primary" disabled={saving} onClick={() => decide(profile, 'approved')}>Approve technician</button>
          <button className="glass-button-secondary" disabled={saving} onClick={() => decide(profile, 'rejected')}>Decline application</button>
        </div>
      </article>)}
      {pages > 1 && <nav className="flex gap-4"><button disabled={page === 1 || saving} onClick={() => setPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span><button disabled={page === pages || saving} onClick={() => setPage(page + 1)}>Next</button></nav>}
    </>}
  </section>;
}
